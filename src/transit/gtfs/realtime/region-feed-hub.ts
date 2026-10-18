import type { Env } from '../../../types';
import { SFBAY_REGION, SFBAY_COVERAGE } from '../../../regions/sfbay';
import type { RealtimeFeedKind, RealtimeFeedSpec } from '../../../regions/types';
import { allocatePollIntervals } from '../upstream/budget';
import { buildUpstreamRequest } from '../upstream/request';
import { decodeRealtimeFeed, type NormalizedRealtimeFeed } from './decode';
import { RegionalFeedHubCore } from './hub-core';
import { ApiKeyQuota, RealtimeSnapshotStore, StaticArtifactStore, readBoundedObject, SF511_QUOTA_NAMESPACE } from './snapshot-store';
import { loadScheduleWindow } from '../../planner/schedule-index';
import { applyTripUpdates } from './trip-match';
import { decodeDiscoveryIndex, sha256 } from '../static/shards';

const POLLED_PREFIX = 'polled:';

function polledKey(kind: RealtimeFeedKind): string {
  return `${POLLED_PREFIX}${kind}`;
}

export function pollAttemptState(kind: RealtimeFeedKind, nowSeconds: number): Record<string, number> {
  return { [polledKey(kind)]: nowSeconds };
}

export function safePollFailureReason(error: unknown): string {
  if (error instanceof Error && error.message === 'upstream_body_too_large') return error.message;
  if (error instanceof Error && error.message === 'Malformed GTFS-Realtime feed') return 'malformed_feed';
  return 'upstream_request_failed';
}

function payloadFor(kind: RealtimeFeedKind, feed: NormalizedRealtimeFeed): unknown[] {
  if (kind === 'trip_updates') return feed.tripUpdates;
  if (kind === 'vehicle_positions') return feed.vehicles;
  return feed.alerts;
}

export class RegionFeedHub implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #intervals: Record<RealtimeFeedKind, number>;
  readonly #snapshots?: RealtimeSnapshotStore;
  readonly #artifacts?: StaticArtifactStore;
  readonly #quota: ApiKeyQuota;
  readonly #coordinator: boolean;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    this.#coordinator = !state.id || state.id.toString() === env.REGION_FEED_HUB?.idFromName(SF511_QUOTA_NAMESPACE).toString();
    this.#quota = new ApiKeyQuota(state.storage, SFBAY_REGION.realtime.budget);
    if (env.TRANSIT_ARTIFACTS) {
      this.#snapshots = new RealtimeSnapshotStore(state.storage, env.TRANSIT_ARTIFACTS);
      this.#artifacts = new StaticArtifactStore(env.TRANSIT_ARTIFACTS);
    }
    this.#intervals = allocatePollIntervals({
      ...SFBAY_REGION.realtime.budget,
      feeds: SFBAY_REGION.realtime.feeds.map(feed => ({
        id: feed.kind,
        weight: feed.weight,
        minIntervalSeconds: feed.minIntervalSeconds,
      })),
    }) as Record<RealtimeFeedKind, number>;
    state.blockConcurrencyWhile(async () => {
      if (!this.#coordinator) return;
      if (await state.storage.getAlarm() == null) {
        await state.storage.setAlarm(Date.now() + 1_000);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.#coordinator) return Response.json({ error: 'inactive_coordinator' }, { status: 409 });
    if (url.pathname === '/health') return new Response(null, { status: 204 });
    if (url.pathname === '/quota/static' && request.method === 'POST') {
      return Response.json({ allowed: await this.#quota.claim('static', Math.floor(Date.now() / 1000)) });
    }
    const kind = url.pathname.slice(1) as RealtimeFeedKind;
    if (!SFBAY_REGION.realtime.feeds.some(feed => feed.kind === kind)) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const now = Number(url.searchParams.get('now')) || Math.floor(Date.now() / 1_000);
    const core = new RegionalFeedHubCore(SFBAY_COVERAGE.thresholds);
    const current = await this.#artifacts?.current();
    if (!current || !this.#snapshots) return Response.json(core.read(kind, now));
    if (url.searchParams.get('artifact') !== current.version.artifactVersion) {
      return Response.json({ ...core.read(kind, now), version: current.version, degraded: true, warnings: ['SCHEDULE_REALTIME_MISMATCH'] });
    }
    const stops = url.searchParams.getAll('stop');
    const snapshot = await this.#snapshots.read(kind, current.version, stops.length && kind === 'trip_updates' ? stops : undefined);
    if (snapshot) core.replace(kind, snapshot);
    return Response.json(core.read(kind, now));
  }

  async alarm(): Promise<void> {
    if (!this.#coordinator) return;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (this.#env.SFBAY_MODE !== 'off' && this.#env.SFBAY_MODE !== 'suspended' && this.#env.SF511_API_KEY) {
      for (const feed of SFBAY_REGION.realtime.feeds) {
        const lastPolled = await this.#state.storage.get<number>(polledKey(feed.kind)) ?? 0;
        if (nowSeconds - lastPolled >= this.#intervals[feed.kind]) {
          await this.#poll(feed, nowSeconds);
        }
      }
    }
    const nextInterval = Math.min(...Object.values(this.#intervals));
    await this.#state.storage.setAlarm(Date.now() + nextInterval * 1_000);
  }

  async #poll(spec: RealtimeFeedSpec, nowSeconds: number): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), spec.timeoutMs);
    try {
      const current = await this.#artifacts?.current();
      if (!current || !this.#snapshots || !this.#env.TRANSIT_ARTIFACTS) return;
      if (!await this.#quota.claim(spec.kind, nowSeconds)) return;
      await this.#state.storage.put(pollAttemptState(spec.kind, nowSeconds));
      const upstream = buildUpstreamRequest(spec.url, this.#env.SF511_API_KEY!);
      const response = await fetch(upstream, { signal: controller.signal });
      if (!response.ok) throw new Error(`upstream_status_${response.status}`);
      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > spec.maxBytes) {
        throw new Error('upstream_body_too_large');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('upstream_empty_body');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > spec.maxBytes) { await reader.cancel(); throw new Error('upstream_body_too_large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const decoded = decodeRealtimeFeed(bytes);
      let payload = payloadFor(spec.kind, decoded), warnings = decoded.warnings, degraded = false;
      if (spec.kind === 'trip_updates') {
        const window = await loadScheduleWindow({ manifest: current.manifest, instant: new Date(nowSeconds * 1000).toISOString(), windowSeconds: 6 * 3600,
          readShard: key => readBoundedObject(this.#env.TRANSIT_ARTIFACTS!, key, 64 * 1024 * 1024) });
        const descriptors = current.manifest.discoveries.filter(item => item.feedId === 'sf511');
        if (descriptors.length !== 1) throw new Error('Discovery identity missing or ambiguous');
        const descriptor = descriptors[0]!;
        const discoveryBytes = await readBoundedObject(this.#env.TRANSIT_ARTIFACTS, descriptor.key, Math.min(descriptor.byteLength, 64 * 1024 * 1024));
        if (discoveryBytes.length !== descriptor.byteLength || await sha256(discoveryBytes) !== descriptor.sha256) throw new Error('Discovery integrity failure');
        const discovery = decodeDiscoveryIndex(discoveryBytes);
        const applied = await applyTripUpdates(decoded, { manifest: current.manifest, shards: window.shards.map(entry => entry.shard), discoveries: [discovery], version: current.version, feedId: 'sf511' });
        payload = applied.stopUpdates; degraded = applied.degraded || window.status === 'unavailable'; warnings = [...applied.warnings, ...window.reasons];
      }
      await this.#snapshots.publish(spec.kind, {
          version: current.version,
          producerTimestampSeconds: decoded.producerTimestampSeconds,
          receivedAtSeconds: nowSeconds,
          payload, warnings, degraded,
      });
    } catch (error) {
      const reason = safePollFailureReason(error);
      if (reason === 'malformed_feed') {
        await this.#snapshots?.warn(spec.kind, reason);
      }
      console.warn(JSON.stringify({
        event: 'regional_feed_poll_failed',
        region: 'sfbay',
        feed: spec.kind,
        reason,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
