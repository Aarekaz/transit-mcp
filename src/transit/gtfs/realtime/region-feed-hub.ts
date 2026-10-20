import type { Env } from '../../../types';
import type { RealtimeFeedKind, RealtimeFeedSpec } from '../../../regions/types';
import { allocatePollIntervals } from '../upstream/budget';
import { decodeRealtimeFeed, type NormalizedAlert, type NormalizedRealtimeFeed } from './decode';
import { RegionalFeedHubCore } from './hub-core';
import { ApiKeyQuota, RealtimeSnapshotStore, StaticArtifactStore, readBoundedObject, type StaticVersion } from './snapshot-store';
import { DecodedShardCache, loadScheduleWindow } from '../../planner/schedule-index';
import { MIN_ELIGIBLE_FOR_MATCH_RATE, applyTripUpdates, applyVehiclePositions, matchVehicles, settleStoppedVehicles, type AppliedTripUpdates } from './trip-match';
import { decodeDiscoveryIndex, sha256 } from '../static/shards';
import type { ArtifactManifestV2, DiscoveryIndex } from '../static/schema';
import { decodeEquipmentOutages } from '../../accessibility/equipment';
import { feedParts, getRealtimeSource, getRealtimeSources, ingestionActive, publishedKinds, sourceFeedIds, upstreamRequest, type RealtimeSource } from './sources';

const POLLED_PREFIX = 'polled:';
/** Calls this long before the poll are not published. */
export const PAST_CALL_SECONDS = 600;

function polledKey(kind: RealtimeFeedKind): string {
  return `${POLLED_PREFIX}${kind}`;
}

export function pollAttemptState(kind: RealtimeFeedKind, nowSeconds: number): Record<string, number> {
  return { [polledKey(kind)]: nowSeconds };
}

export function safePollFailureReason(error: unknown): string {
  if (error instanceof Error && error.message === 'upstream_body_too_large') return error.message;
  if (error instanceof Error && (error.message === 'Malformed GTFS-Realtime feed' || error.message === 'Malformed equipment feed')) return 'malformed_feed';
  if (error instanceof Error && error.message.startsWith('incomplete_feed')) return 'incomplete_feed';
  if (error instanceof Error && /^Realtime (payload byte|metadata) budget exceeded$/.test(error.message)) return 'snapshot_budget_exceeded';
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

/** True when the sorted provider ID list (a discovery index's tripProviderIds) holds `id`. */
function listed(sorted: readonly string[], id: string): boolean {
  let low = 0, high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, value = sorted[middle]!;
    if (value === id) return true;
    if (value < id) low = middle + 1; else high = middle - 1;
  }
  return false;
}

/** One realtime document for several timetables (MTA Bus Time): each trip and vehicle goes
 * to the feed whose timetable lists its trip_id; one no timetable lists goes to the first. */
export function routeByTimetable(feed: NormalizedRealtimeFeed, discoveries: readonly DiscoveryIndex[]): NormalizedRealtimeFeed[] {
  const owner = (tripId: string | undefined) => Math.max(0, tripId === undefined ? 0 : discoveries.findIndex(discovery => listed(discovery.tripProviderIds, tripId)));
  const entities = feed.trips.map(trip => owner(trip.tripId)), byEntity = new Map(feed.trips.map((trip, index) => [trip.entityId, entities[index]!]));
  return discoveries.map((_, index) => ({ ...feed,
    trips: feed.trips.filter((_, position) => entities[position] === index),
    tripUpdates: feed.tripUpdates.filter(update => (byEntity.get(update.entityId) ?? 0) === index),
    vehicles: feed.vehicles.filter(vehicle => owner(vehicle.tripId) === index) }));
}

/** Matching across several timetables is judged on the combined totals: one borough's few
 * trips say nothing about the schedule's identity. */
export function combineApplied(results: readonly AppliedTripUpdates[], minimumScheduleMatchRate: number, version: AppliedTripUpdates['version']): AppliedTripUpdates {
  const sum = (pick: (result: AppliedTripUpdates) => number) => results.reduce((total, result) => total + pick(result), 0);
  const eligible = sum(result => result.match.eligible), matched = sum(result => result.match.matched), rate = eligible ? matched / eligible : 1;
  const excluded = { nonRevenue: sum(result => result.excluded.nonRevenue), invalidExtras: sum(result => result.excluded.invalidExtras),
    unrepresentableAdded: sum(result => result.excluded.unrepresentableAdded), beyondWindow: sum(result => result.excluded.beyondWindow) };
  const mismatched = eligible >= MIN_ELIGIBLE_FOR_MATCH_RATE ? rate < minimumScheduleMatchRate : eligible > 0 && matched === 0;
  const degraded = excluded.invalidExtras > 0 || mismatched;
  const warnings = [...new Set(results.flatMap(result => result.warnings).filter(warning => warning !== 'SCHEDULE_REALTIME_MISMATCH'))];
  return { version, trips: results.flatMap(result => result.trips), stopUpdates: results.flatMap(result => result.stopUpdates),
    match: { eligible, matched, rate }, excluded, degraded, warnings: [...warnings, ...(degraded ? ['SCHEDULE_REALTIME_MISMATCH'] : [])] };
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
  // Polls reuse the verified timetable and discovery index while their hashes are unchanged.
  readonly #shards = new DecodedShardCache(24 * 1024 * 1024);
  readonly #discoveries = new Map<string, { sha256: string; index: DiscoveryIndex }>();
  /** The published artifact as of this coordinator's last poll or mismatched read. Reads never
   * wait on R2 for it: while a poll uploads a snapshot, R2 connections are all in use. */
  #current?: { version: StaticVersion; manifest: ArtifactManifestV2 };
  async #artifact(): Promise<{ version: StaticVersion; manifest: ArtifactManifestV2 } | undefined> {
    return this.#current = await this.#artifacts?.current() ?? undefined;
  }

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
      const primary = getRealtimeSource(source.coverage.id)?.policy.feedId === source.policy.feedId;
      this.#snapshots = new RealtimeSnapshotStore(state.storage, env.TRANSIT_ARTIFACTS, source.coverage.id, primary ? undefined : source.policy.feedId);
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
    if (url.pathname === '/stats') {
      const feed = url.searchParams.get('feed');
      return Response.json(await this.#state.storage.get(feed ? `stats:trip_updates:${feed}` : 'stats:trip_updates') ?? await this.#state.storage.get('stats:trip_updates') ?? null);
    }
    if (url.pathname === '/quota/static' && request.method === 'POST') {
      return Response.json({ allowed: await this.#quota!.claim('static', Math.floor(Date.now() / 1000)) });
    }
    const kind = url.pathname.slice(1) as RealtimeFeedKind;
    if (!publishedKinds(source).has(kind)) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const now = Number(url.searchParams.get('now')) || Math.floor(Date.now() / 1_000);
    const core = new RegionalFeedHubCore(source.coverage.thresholds);
    // A request for another version (a refresh or rollback just happened) rereads the pointer.
    const current = this.#current?.version.artifactVersion === url.searchParams.get('artifact') ? this.#current : await this.#artifact();
    if (!current || !this.#snapshots) return Response.json(core.read(kind, now));
    if (url.searchParams.get('artifact') !== current.version.artifactVersion) {
      return Response.json({ ...core.read(kind, now), version: current.version, degraded: true, warnings: ['SCHEDULE_REALTIME_MISMATCH'] });
    }
    const stops = url.searchParams.getAll('stop');
    const snapshot = await this.#snapshots.read(kind, current.version, stops.length && kind === 'trip_updates' ? stops : undefined);
    if (snapshot) core.replace(kind, snapshot);
    const read = core.read(kind, now);
    // The reader already holds this exact payload: send only the freshness metadata.
    if (read.etag && url.searchParams.get('have') === read.etag) return Response.json({ ...read, payload: null, notModified: true });
    return Response.json(read);
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

  async #fetchBytes(source: RealtimeSource, spec: RealtimeFeedSpec, url: URL, nowSeconds: number): Promise<Uint8Array> {
    if (!await this.#quota!.claim(spec.kind, nowSeconds)) throw new Error('upstream_quota_exhausted');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), spec.timeoutMs);
    try {
      const response = await fetch(upstreamRequest(source, url, this.#env, spec.accept), { signal: controller.signal });
      if (!response.ok) throw new Error(`upstream_status_${response.status}`);
      return await readBody(response, spec.maxBytes);
    } finally {
      clearTimeout(timeout);
    }
  }

  async #fetchPart(source: RealtimeSource, spec: RealtimeFeedSpec, url: URL, nowSeconds: number): Promise<NormalizedRealtimeFeed> {
    return decodeRealtimeFeed(await this.#fetchBytes(source, spec, url, nowSeconds), { nyct: source.policy.extensions === 'nyct', mtaRailroad: source.policy.extensions === 'mta_railroad' });
  }

  /** Agency equipment reports carry no feed clock: a complete, validated retrieval is the
   * observation, dated when the last part arrived. All parts or nothing, as for trip feeds. */
  async #pollEquipment(source: RealtimeSource, spec: RealtimeFeedSpec, nowSeconds: number, version: StaticVersion): Promise<void> {
    const parts = feedParts(spec);
    const settled = await Promise.allSettled(parts.map(part => this.#fetchBytes(source, spec, part.url, nowSeconds)));
    const failed = settled.flatMap((result, index) => result.status === 'rejected' ? [parts[index]!.id] : []);
    if (failed.length) {
      if (parts.length === 1) throw (settled[0] as PromiseRejectedResult).reason;
      await this.#snapshots!.warn(spec.kind, 'incomplete_feed');
      throw new Error(`incomplete_feed:${failed.join(',')}`);
    }
    const observedAt = Math.floor(Date.now() / 1000);
    const decoded = decodeEquipmentOutages(spec.format!, Object.fromEntries(parts.map((part, index) => [part.id, (settled[index] as PromiseFulfilledResult<Uint8Array>).value])));
    await this.#snapshots!.publish(spec.kind, { version, producerTimestampSeconds: observedAt, receivedAtSeconds: observedAt, payload: decoded.outages, warnings: decoded.warnings, degraded: false });
    console.info(JSON.stringify({ event: 'regional_feed_polled', region: source.coverage.id, feed: spec.kind, outages: decoded.outages.length }));
  }

  async #poll(source: RealtimeSource, spec: RealtimeFeedSpec, nowSeconds: number): Promise<void> {
    const { coverage, policy } = source;
    try {
      const current = await this.#artifact();
      if (!current || !this.#snapshots || !this.#env.TRANSIT_ARTIFACTS) return;
      // A feed whose schedule is not published yet has nothing to match: spend no request.
      const feedIds = sourceFeedIds(policy).filter(feedId => current.manifest.sources.some(item => item.feedId === feedId));
      if (!feedIds.length) return;
      await this.#state.storage.put(pollAttemptState(spec.kind, nowSeconds));
      if (spec.format) return await this.#pollEquipment(source, spec, nowSeconds, current.version);
      const parts = feedParts(spec);
      const timings: Record<string, number> = {}, startedAt = Date.now();
      const lap = (phase: string) => { timings[phase] = Date.now() - startedAt; };
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
      lap('fetched');
      let payload = payloadFor(spec.kind, decoded), warnings = decoded.warnings, degraded = false, vehicles: unknown[] | undefined;
      const readShard = (key: string) => readBoundedObject(this.#env.TRANSIT_ARTIFACTS!, key, 64 * 1024 * 1024);
      const matchWindow = (feedId: string) => loadScheduleWindow({ manifest: current.manifest, instant: new Date(nowSeconds * 1000).toISOString(),
        windowSeconds: policy.matchWindowSeconds ?? 6 * 3600, readShard, feedIds: [feedId], decoded: this.#shards });
      const matching = (feedId: string) => ({ manifest: current.manifest, version: current.version, feedId, tripMatching: policy.tripMatching,
        minimumScheduleMatchRate: coverage.thresholds.minimumScheduleMatchRate, horizonEndSeconds: nowSeconds + (policy.matchWindowSeconds ?? 6 * 3600) });
      const discoveryOf = async (feedId: string) => {
        const descriptors = current.manifest.discoveries.filter(item => item.feedId === feedId);
        if (descriptors.length !== 1) throw new Error('Discovery identity missing or ambiguous');
        const descriptor = descriptors[0]!, held = this.#discoveries.get(feedId);
        if (held?.sha256 === descriptor.sha256) return held.index;
        const discoveryBytes = await readBoundedObject(this.#env.TRANSIT_ARTIFACTS!, descriptor.key, Math.min(descriptor.byteLength, 64 * 1024 * 1024));
        if (discoveryBytes.length !== descriptor.byteLength || await sha256(discoveryBytes) !== descriptor.sha256) throw new Error('Discovery integrity failure');
        const index = decodeDiscoveryIndex(discoveryBytes);
        this.#discoveries.set(feedId, { sha256: descriptor.sha256, index });
        return index;
      };
      if (spec.kind === 'trip_updates' || spec.kind === 'vehicle_positions') {
        const discoveries = await Promise.all(feedIds.map(discoveryOf));
        lap('discovery');
        const routed = feedIds.length === 1 ? [decoded] : routeByTimetable(decoded, discoveries);
        const applied: AppliedTripUpdates[] = [], matchedVehicles: unknown[] = [];
        let unavailable = false, windowReasons: string[] = [];
        for (const [index, feedId] of feedIds.entries()) {
          const part = routed[index]!;
          if (!part.trips.length && !part.vehicles.length && feedIds.length > 1) continue;
          const window = await matchWindow(feedId), shards = window.shards.map(entry => entry.shard);
          unavailable ||= window.status === 'unavailable'; windowReasons = [...windowReasons, ...window.reasons];
          if (spec.kind === 'vehicle_positions') { matchedVehicles.push(...await applyVehiclePositions(part.vehicles, { ...matching(feedId), shards })); continue; }
          const result = await applyTripUpdates(part, { ...matching(feedId), shards, discoveries: [discoveries[index]!] });
          applied.push(result);
          await this.#state.storage.put(`stats:trip_updates:${feedId}`, { artifactVersion: current.version.artifactVersion, ...result.match, atSeconds: nowSeconds });
          // Same documents, same verified shards: no second fetch or integrity pass.
          if (spec.alsoPublishes?.includes('vehicle_positions')) matchedVehicles.push(...matchVehicles(settleStoppedVehicles(part.vehicles, part.trips), { ...matching(feedId), shards }));
        }
        lap('matched');
        if (spec.kind === 'vehicle_positions') payload = matchedVehicles;
        else {
          const combined = applied.length === 1 ? applied[0]! : combineApplied(applied, coverage.thresholds.minimumScheduleMatchRate, current.version);
          // Publish the calls someone can still use: none more than ten minutes past, and none
          // beyond the timetable span this poll matched against. Elsewhere the timetable
          // stands. A busy bus network's snapshot is otherwise mostly passed or distant calls.
          const past = nowSeconds - PAST_CALL_SECONDS, horizon = nowSeconds + (policy.matchWindowSeconds ?? 6 * 3600);
          payload = combined.stopUpdates.filter(row => {
            const times = [row.departureTimeSeconds, row.arrivalTimeSeconds, row.scheduledDepartureTimeSeconds, row.scheduledArrivalTimeSeconds].filter((time): time is number => time !== undefined);
            return !times.length || times.some(time => time >= past && time <= horizon);
          });
          degraded = combined.degraded || unavailable; warnings = [...combined.warnings, ...windowReasons];
          if (spec.alsoPublishes?.includes('vehicle_positions')) vehicles = matchedVehicles;
          Object.assign(timings, { rows: payload.length });
          console.info(JSON.stringify({ event: 'regional_trip_match', region: coverage.id, feed: policy.feedId, ...combined.match, ...combined.excluded }));
          // The schedule refresh compares this before and after publishing a new artifact.
          await this.#state.storage.put('stats:trip_updates', { artifactVersion: current.version.artifactVersion, ...combined.match, atSeconds: nowSeconds });
        }
      }
      if (spec.kind === 'service_alerts') payload = aliasAlertAgencies(decoded.alerts, policy.alertAgencyAliases);
      await this.#snapshots.publish(spec.kind, {
        version: current.version,
        producerTimestampSeconds: decoded.producerTimestampSeconds,
        receivedAtSeconds: Math.floor(Date.now() / 1000),
        payload, warnings, degraded,
      });
      if (vehicles) {
        await this.#snapshots.publish('vehicle_positions', { version: current.version, producerTimestampSeconds: decoded.producerTimestampSeconds,
          receivedAtSeconds: Math.floor(Date.now() / 1000), payload: vehicles, warnings: decoded.warnings, degraded });
        Object.assign(timings, { vehicles: vehicles.length });
      }
      lap('published');
      console.info(JSON.stringify({ event: 'regional_feed_polled', region: coverage.id, source: policy.feedId, feed: spec.kind, ...timings }));
    } catch (error) {
      const reason = safePollFailureReason(error);
      if (reason === 'malformed_feed') await this.#snapshots?.warn(spec.kind, reason);
      console.warn(JSON.stringify({ event: 'regional_feed_poll_failed', region: coverage.id, feed: spec.kind, reason,
        ...(error instanceof Error && error.message.startsWith('incomplete_feed:') ? { parts: error.message.slice('incomplete_feed:'.length).split(',') } : {}) }));
    }
  }
}
