import type { Env } from '../../../types';
import type { RealtimeFeedKind, RealtimeFeedSpec } from '../../../regions/types';
import { allocatePollIntervals } from '../upstream/budget';
import { decodeRealtimeFeed, type NormalizedAlert, type NormalizedRealtimeFeed } from './decode';
import { RegionalFeedHubCore } from './hub-core';
import { ApiKeyQuota, RealtimeSnapshotStore, StaticArtifactStore, readBoundedObject } from './snapshot-store';
import { loadScheduleWindow } from '../../planner/schedule-index';
import { applyTripUpdates, applyVehiclePositions } from './trip-match';
import { decodeDiscoveryIndex, sha256 } from '../static/shards';
import { feedParts, getRealtimeSource, getRealtimeSources, ingestionActive, upstreamRequest, type RealtimeSource } from './sources';

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
  if (error instanceof Error && error.message.startsWith('incomplete_feed')) return 'incomplete_feed';
  // Fixed vocabulary only: never echo upstream bodies, URLs or credentials.
  if (error instanceof Error && /^upstream_(status_\d{3}|quota_exhausted|credential_missing|empty_body)$/.test(error.message)) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return 'upstream_timeout';
  return 'upstream_request_failed';
}

function payloadFor(kind: RealtimeFeedKind, feed: NormalizedRealtimeFeed): unknown[] {
  if (kind === 'trip_updates') return feed.tripUpdates;
  if (kind === 'vehicle_positions') return feed.vehicles;
  return feed.alerts;
}

/** All parts or nothing. The oldest part dates the merge, so one frozen document
 * makes the whole snapshot stale rather than silently incomplete. */
export function mergeRealtimeParts(parts: NormalizedRealtimeFeed[]): NormalizedRealtimeFeed {
  const stamps = parts.map(part => part.producerTimestampSeconds);
  return {
    producerTimestampSeconds: stamps.some(stamp => stamp === undefined) ? undefined : Math.min(...stamps as number[]),
    tripUpdates: parts.flatMap(part => part.tripUpdates), trips: parts.flatMap(part => part.trips),
    vehicles: parts.flatMap(part => part.vehicles), alerts: parts.flatMap(part => part.alerts),
    // An empty document is still a complete answer for its lines.
    warnings: [...new Set(parts.flatMap(part => part.warnings))],
  };
}

/** Reviewed provider aliases only; unknown agency IDs remain unmatched. */
export function aliasAlertAgencies(alerts: NormalizedAlert[], aliases: Readonly<Record<string, string>> | undefined): NormalizedAlert[] {
  if (!aliases) return alerts;
  return alerts.map(alert => ({ ...alert, selectors: alert.selectors.map(selector =>
    selector.agencyId !== undefined && Object.hasOwn(aliases, selector.agencyId) ? { ...selector, agencyId: aliases[selector.agencyId] } : selector) }));
}

async function readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) throw new Error('upstream_body_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('upstream_empty_body');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('upstream_body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** One coordinator per coverage owns its provider credential, quota and snapshots. */
export class RegionFeedHub implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #source?: RealtimeSource;
  readonly #intervals: Record<string, number> = {};
  readonly #snapshots?: RealtimeSnapshotStore;
  readonly #artifacts?: StaticArtifactStore;
  readonly #quota?: ApiKeyQuota;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    // Unnamed instances (tests) keep the original SF coordinator identity.
    this.#source = !state.id ? getRealtimeSource('sfbay') : getRealtimeSources().find(source =>
      state.id.toString() === env.REGION_FEED_HUB?.idFromName(source.policy.namespace).toString());
    const source = this.#source;
    if (!source) return;
    this.#quota = new ApiKeyQuota(state.storage, source.policy.budget);
    if (env.TRANSIT_ARTIFACTS) {
      this.#snapshots = new RealtimeSnapshotStore(state.storage, env.TRANSIT_ARTIFACTS, source.coverage.id);
      this.#artifacts = new StaticArtifactStore(env.TRANSIT_ARTIFACTS, source.coverage.id);
    }
    this.#intervals = allocatePollIntervals({
      ...source.policy.budget,
      feeds: source.feeds.map(feed => ({ id: feed.kind, weight: feed.weight, minIntervalSeconds: feed.minIntervalSeconds, requestsPerPoll: feedParts(feed).length })),
    });
    state.blockConcurrencyWhile(async () => {
      if (await state.storage.getAlarm() == null) await state.storage.setAlarm(Date.now() + 1_000);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const source = this.#source;
    if (!source) return Response.json({ error: 'inactive_coordinator' }, { status: 409 });
    if (url.pathname === '/health') return new Response(null, { status: 204 });
    if (url.pathname === '/quota/static' && request.method === 'POST') {
      return Response.json({ allowed: await this.#quota!.claim('static', Math.floor(Date.now() / 1000)) });
    }
    const kind = url.pathname.slice(1) as RealtimeFeedKind;
    if (!source.feeds.some(feed => feed.kind === kind)) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const now = Number(url.searchParams.get('now')) || Math.floor(Date.now() / 1_000);
    const core = new RegionalFeedHubCore(source.coverage.thresholds);
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
    const source = this.#source;
    if (!source) return;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const active = ingestionActive(source, this.#env);
    if (active) {
      for (const feed of source.feeds) {
        const lastPolled = await this.#state.storage.get<number>(polledKey(feed.kind)) ?? 0;
        const attemptSeconds = Math.floor(Date.now() / 1000);
        if (attemptSeconds - lastPolled >= this.#intervals[feed.kind]!) {
          await this.#poll(source, feed, attemptSeconds);
        }
      }
    }
    const nextInterval = Math.min(...Object.values(this.#intervals));
    let next = (nowSeconds + nextInterval) * 1000;
    if (active) {
      const deadlines = await Promise.all(source.feeds.map(async feed => {
        const last = await this.#state.storage.get<number>(polledKey(feed.kind));
        // Missing artifacts/quota or an overrun back off; never catch up with a burst.
        const deadline = last === undefined ? 0 : (last + this.#intervals[feed.kind]!) * 1000;
        return deadline > Date.now() ? deadline : Date.now() + 30_000;
      }));
      next = Math.min(...deadlines);
    }
    await this.#state.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }

  async #fetchPart(source: RealtimeSource, spec: RealtimeFeedSpec, url: URL, nowSeconds: number): Promise<NormalizedRealtimeFeed> {
    if (!await this.#quota!.claim(spec.kind, nowSeconds)) throw new Error('upstream_quota_exhausted');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), spec.timeoutMs);
    try {
      const response = await fetch(upstreamRequest(source, url, this.#env), { signal: controller.signal });
      if (!response.ok) throw new Error(`upstream_status_${response.status}`);
      return decodeRealtimeFeed(await readBody(response, spec.maxBytes));
    } finally {
      clearTimeout(timeout);
    }
  }

  async #poll(source: RealtimeSource, spec: RealtimeFeedSpec, nowSeconds: number): Promise<void> {
    const { coverage, policy } = source;
    try {
      const current = await this.#artifacts?.current();
      if (!current || !this.#snapshots || !this.#env.TRANSIT_ARTIFACTS) return;
      await this.#state.storage.put(pollAttemptState(spec.kind, nowSeconds));
      const parts = feedParts(spec);
      const settled = await Promise.allSettled(parts.map(part => this.#fetchPart(source, spec, part.url, nowSeconds)));
      const failed = settled.flatMap((result, index) => result.status === 'rejected' ? [parts[index]!.id] : []);
      if (failed.length) {
        if (parts.length === 1) throw (settled[0] as PromiseRejectedResult).reason;
        // Never publish a partial merge. The last complete snapshot ages into
        // stale/expired by its own producer clock.
        await this.#snapshots.warn(spec.kind, 'incomplete_feed');
        throw new Error(`incomplete_feed:${failed.join(',')}`);
      }
      const decoded = mergeRealtimeParts(settled.map(result => (result as PromiseFulfilledResult<NormalizedRealtimeFeed>).value));
      let payload = payloadFor(spec.kind, decoded), warnings = decoded.warnings, degraded = false;
      const readShard = (key: string) => readBoundedObject(this.#env.TRANSIT_ARTIFACTS!, key, 64 * 1024 * 1024);
      const matchWindow = () => loadScheduleWindow({ manifest: current.manifest, instant: new Date(nowSeconds * 1000).toISOString(),
        windowSeconds: policy.matchWindowSeconds ?? 6 * 3600, readShard, feedIds: [policy.feedId] });
      const matching = { manifest: current.manifest, version: current.version, feedId: policy.feedId, tripMatching: policy.tripMatching,
        minimumScheduleMatchRate: coverage.thresholds.minimumScheduleMatchRate };
      if (spec.kind === 'trip_updates') {
        const window = await matchWindow();
        const descriptors = current.manifest.discoveries.filter(item => item.feedId === policy.feedId);
        if (descriptors.length !== 1) throw new Error('Discovery identity missing or ambiguous');
        const descriptor = descriptors[0]!;
        const discoveryBytes = await readBoundedObject(this.#env.TRANSIT_ARTIFACTS, descriptor.key, Math.min(descriptor.byteLength, 64 * 1024 * 1024));
        if (discoveryBytes.length !== descriptor.byteLength || await sha256(discoveryBytes) !== descriptor.sha256) throw new Error('Discovery integrity failure');
        const discovery = decodeDiscoveryIndex(discoveryBytes);
        const applied = await applyTripUpdates(decoded, { ...matching, shards: window.shards.map(entry => entry.shard), discoveries: [discovery] });
        payload = applied.stopUpdates; degraded = applied.degraded || window.status === 'unavailable'; warnings = [...applied.warnings, ...window.reasons];
        console.info(JSON.stringify({ event: 'regional_trip_match', region: coverage.id, ...applied.match, ...applied.excluded }));
      }
      if (spec.kind === 'vehicle_positions') {
        const window = await matchWindow();
        payload = await applyVehiclePositions(decoded.vehicles, { ...matching, shards: window.shards.map(entry => entry.shard) });
      }
      if (spec.kind === 'service_alerts') payload = aliasAlertAgencies(decoded.alerts, policy.alertAgencyAliases);
      await this.#snapshots.publish(spec.kind, {
        version: current.version,
        producerTimestampSeconds: decoded.producerTimestampSeconds,
        receivedAtSeconds: Math.floor(Date.now() / 1000),
        payload, warnings, degraded,
      });
    } catch (error) {
      const reason = safePollFailureReason(error);
      if (reason === 'malformed_feed') await this.#snapshots?.warn(spec.kind, reason);
      console.warn(JSON.stringify({ event: 'regional_feed_poll_failed', region: coverage.id, feed: spec.kind, reason,
        ...(error instanceof Error && error.message.startsWith('incomplete_feed:') ? { parts: error.message.slice('incomplete_feed:'.length).split(',') } : {}) }));
    }
  }
}
