import type { Env } from '../../../types';
import { SFBAY_REGION } from '../../../regions/sfbay';
import type { RealtimeFeedKind, RealtimeFeedSpec } from '../../../regions/types';
import { allocatePollIntervals } from '../upstream/budget';
import { buildUpstreamRequest } from '../upstream/request';
import { decodeRealtimeFeed, type NormalizedRealtimeFeed } from './decode';
import { RegionalFeedHubCore, type FeedSnapshot } from './hub-core';

const SNAPSHOT_PREFIX = 'snapshot:';
const POLLED_PREFIX = 'polled:';

function snapshotKey(kind: RealtimeFeedKind): string {
  return `${SNAPSHOT_PREFIX}${kind}`;
}

function polledKey(kind: RealtimeFeedKind): string {
  return `${POLLED_PREFIX}${kind}`;
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

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
    this.#intervals = allocatePollIntervals({
      ...SFBAY_REGION.realtime.budget,
      feeds: SFBAY_REGION.realtime.feeds.map(feed => ({
        id: feed.kind,
        weight: feed.weight,
        minIntervalSeconds: feed.minIntervalSeconds,
      })),
    }) as Record<RealtimeFeedKind, number>;
    state.blockConcurrencyWhile(async () => {
      if (await state.storage.getAlarm() == null) {
        await state.storage.setAlarm(Date.now() + 1_000);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const kind = url.pathname.slice(1) as RealtimeFeedKind;
    if (!SFBAY_REGION.realtime.feeds.some(feed => feed.kind === kind)) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const now = Number(url.searchParams.get('now')) || Math.floor(Date.now() / 1_000);
    const snapshot = await this.#state.storage.get<FeedSnapshot<unknown[]>>(snapshotKey(kind));
    const core = new RegionalFeedHubCore(this.#intervals);
    if (snapshot) core.replace(kind, snapshot);
    return Response.json(core.read(kind, now));
  }

  async alarm(): Promise<void> {
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
      const upstream = buildUpstreamRequest(spec.url, this.#env.SF511_API_KEY!);
      const response = await fetch(upstream, { signal: controller.signal });
      if (!response.ok) throw new Error(`upstream_status_${response.status}`);
      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > spec.maxBytes) {
        throw new Error('upstream_body_too_large');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > spec.maxBytes) throw new Error('upstream_body_too_large');
      const decoded = decodeRealtimeFeed(bytes);
      await this.#state.storage.put({
        [snapshotKey(spec.kind)]: {
          producerTimestampSeconds: decoded.producerTimestampSeconds,
          receivedAtSeconds: nowSeconds,
          payload: payloadFor(spec.kind, decoded),
        },
        [polledKey(spec.kind)]: nowSeconds,
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'regional_feed_poll_failed',
        region: 'sfbay',
        feed: spec.kind,
        reason: error instanceof Error ? error.message : 'unknown',
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
