import { parseTransitRef, type TransitRef } from '../core/refs';
import { count, phase } from '../trace';
import type { ArtifactManifestV2, DiscoveryIndex } from '../gtfs/static/schema';
import { parseCompactBand, type CompactBand } from './compact';
import { networkStops, searchNetwork, type NetworkBand, type NetworkJourney } from './network';
import { planJourney } from './plan';
import { assertNotAborted } from './raptor';
import { selectScheduleWindow } from './schedule-index';
import { parseInstant } from './service-day';
import type { Itinerary, JourneyEndpoint, JourneyQuery, JourneyResult } from './types';

/** Compact bands live beside the artifacts, outside their collected prefix, named by the
 * shard and discovery they were built from: immutable, so any isolate may keep them. */
export const compactPrefix = (coverageId: string) => `compact/${coverageId}/`;
export const compactKey = (coverageId: string, shardSha256: string, discoverySha256: string) => `${compactPrefix(coverageId)}${shardSha256}-${discoverySha256.slice(0, 16)}.bin`;

/** Loaded bands by key, least recently used out first. Bytes are views, not copies. */
const BAND_CACHE_BYTES = 40 * 1024 * 1024;
const bands = new Map<string, CompactBand & { bytes: number }>();
let cachedBytes = 0;
function cache(key: string, band: CompactBand, bytes: number): void {
  if (bands.has(key)) return;
  bands.set(key, { ...band, bytes }); cachedBytes += bytes;
  for (const [old, entry] of bands) { if (cachedBytes <= BAND_CACHE_BYTES) break; bands.delete(old); cachedBytes -= entry.bytes; }
}

export interface NetworkPlanQuery extends JourneyQuery {
  manifest: ArtifactManifestV2; indexes: readonly DiscoveryIndex[];
  /** Every feed the open search may ride, buses included. */
  networkFeedIds: readonly string[];
  /** Reads a compact band, or null when it has not been built yet. */
  readCompact: (key: string) => Promise<Uint8Array | null>;
  /** Predictions for a proposal's lines, when they differ from `realtime` (a bus line reads
   * its own stops'). Null: the predictions cannot be used, so the proposal is not planned. */
  realtimeFor?: (routeRefs: ReadonlySet<TransitRef>, feedIds: string[]) => Promise<JourneyQuery['realtime'] | null>;
}
/** Route sets tried by the exact planner, at most. */
const ROUTE_SETS = 4;
/** The exact search window ends this long after the latest proposal arrives. */
const EXACT_SLACK_SECONDS = 1800;
/** Shard bytes all exact searches of one plan may read. Each keeps only its lines' trips
 * (about half the bytes read, measured on Metrobus), and one shard is parsed at a time. */
const EXACT_READ_BYTES = 48 * 1024 * 1024;

/** Open journey search over the whole network (all feeds, buses included) in two steps: a
 * compact network-wide RAPTOR proposes which lines to ride, then the existing planner
 * searches along exactly those lines and validates every itinerary, with realtime,
 * pathways and step-free rules unchanged. Returns null when the compact timetable is not
 * available for this window or no proposal could be confirmed: the caller then behaves as
 * before. */
export async function planNetworkJourney(query: NetworkPlanQuery, signal?: AbortSignal): Promise<JourneyResult | null> {
  return phase('network', () => planNetworkJourneyUntraced(query, signal));
}
async function planNetworkJourneyUntraced(query: NetworkPlanQuery, signal?: AbortSignal): Promise<JourneyResult | null> {
  const begin = parseInstant(query.departAt) / 1000, windowSeconds = query.windowSeconds ?? 7200;
  const maxWalkMetres = Math.min(800, query.maxWalkMetres ?? 800), maxTransfers = query.maxTransfers ?? 3;
  const { window, selected } = selectScheduleWindow({ manifest: query.manifest, instant: query.departAt, windowSeconds, feedIds: [...query.networkFeedIds] });
  if (window.status === 'unavailable' || !selected.length) return null;
  const discoveries = new Map(query.manifest.discoveries.map(descriptor => [descriptor.feedId, descriptor.sha256]));
  const keys = selected.map(item => compactKey(query.manifest.coverageId, item.descriptor.sha256, discoveries.get(item.descriptor.feedId) ?? ''));
  const loaded: (CompactBand | null)[] = new Array(selected.length).fill(null);
  await phase('compact', async () => {
    let next = 0;
    const worker = async () => {
      for (let at = next++; at < keys.length; at = next++) {
        const hit = bands.get(keys[at]!);
        if (hit) { bands.delete(keys[at]!); bands.set(keys[at]!, hit); loaded[at] = hit; continue; }
        const bytes = await query.readCompact(keys[at]!); assertNotAborted(signal);
        if (!bytes) return;
        const band = parseCompactBand(bytes), item = selected[at]!;
        if (band.header.coverageId !== query.manifest.coverageId || band.header.feedId !== item.descriptor.feedId || band.header.shardSha256 !== item.descriptor.sha256 ||
          band.header.discoverySha256 !== discoveries.get(item.descriptor.feedId) || band.header.serviceDate !== item.descriptor.window.startDate) throw new Error('Compact band identity mismatch');
        count('compactRead'); count('compactBytes', bytes.byteLength);
        cache(keys[at]!, band, bytes.byteLength); loaded[at] = band;
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, keys.length) }, worker));
  });
  // A band not built yet (a new artifact, before the compactor reaches it): plan as before.
  if (loaded.some(band => !band)) { count('compactMissing'); return null; }
  const network: NetworkBand[] = loaded.map((band, at) => ({ band: band!, origins: band!.header.agencies.map(agency => {
    const day = selected[at]!.days.find(item => item.agencyRef === agency);
    return day ? parseInstant(day.startTime) / 1000 : undefined;
  }) }));
  const stops = networkStops(query.indexes);
  const search = { stops, bands: network, origin: query.origin, destination: query.destination, originStops: query.originStops, destinationStops: query.destinationStops, begin, end: begin + windowSeconds, maxWalkMetres, maxTransfers,
    ...(query.stepFree ? { usableStops: query.stepFree.usableStopRefs } : {}) };
  // Proposals: the Pareto set (arrival, rides), then the best journey avoiding the line of
  // the longest ride so far, for a real alternative rather than the next train.
  const proposals: NetworkJourney[] = [], seen = new Set<string>(), banned = new Set<TransitRef>();
  const routeKey = (journey: NetworkJourney) => [...new Set(journey.rides.map(ride => ride.routeRef))].sort().join(' ');
  await phase('networkSearch', async () => {
    for (let attempt = 0; attempt < 3 && proposals.length < ROUTE_SETS; attempt++) {
      assertNotAborted(signal);
      const found = searchNetwork(search, banned);
      count('networkSearches');
      for (const journey of found) if (!seen.has(routeKey(journey)) && proposals.length < ROUTE_SETS) { seen.add(routeKey(journey)); proposals.push(journey); }
      const basis = found[0] ?? proposals[0];
      if (!basis) break;
      const longest = basis.rides.reduce((a, b) => b.arrival - b.departure > a.arrival - a.departure ? b : a);
      banned.add(longest.routeRef);
    }
  });
  if (!proposals.length) return null;
  // Only proposals that could be returned are worth an exact search: those arriving close to
  // the best, or with fewer rides than any earlier one.
  const first = proposals.reduce((a, b) => b.arrival < a.arrival ? b : a);
  const slack = Math.max(600, (first.arrival - begin) / 4);
  const worth = proposals.sort((a, b) => a.arrival - b.arrival).filter((proposal, at, all) =>
    proposal.arrival <= first.arrival + slack || all.slice(0, at).every(other => other.rides.length > proposal.rides.length));
  proposals.splice(0, proposals.length, ...worth);
  const routes = new Map(query.indexes.flatMap(index => index.routes).map(route => [route.ref, route]));
  const stopRows = new Map(query.indexes.flatMap(index => index.stops).map(stop => [stop.ref, stop]));
  const end = Math.min(begin + windowSeconds, Math.max(...proposals.map(journey => journey.arrival)) + EXACT_SLACK_SECONDS);
  const candidates: Itinerary[] = [], reasons = new Set<JourneyResult['reasons'][number]>();
  let rounds = 0, workingSet = 0, read = 0;
  // One budget across every exact search: their filtered shards stay in the shared cache.
  const readShard = async (key: string) => {
    const descriptor = query.manifest.shards.find(shard => shard.key === key)!;
    if (read + descriptor.byteLength >= EXACT_READ_BYTES) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
    read += descriptor.byteLength;
    return query.readShard(key);
  };
  for (const proposal of proposals) {
    assertNotAborted(signal);
    const routeRefs = new Set(proposal.rides.map(ride => ride.routeRef));
    const feedIds = [...new Set([...routeRefs].map(ref => parseTransitRef(ref)!.feed))];
    const servedBy = (ref: TransitRef) => [...routeRefs].some(route => query.indexes.some(index => index.stopRoutes[ref]?.includes(route)));
    // An endpoint is planned from the station of its place this proposal rides from (or to);
    // one none of these lines serve is planned from its location, as guided mode does.
    const serves = (ref: TransitRef) => feedIds.includes(parseTransitRef(ref)!.feed) && (servedBy(ref) || [...stopRows.values()].some(child => child.parentStationRef === ref && servedBy(child.ref)));
    const endpoint = (value: JourneyEndpoint, place: readonly TransitRef[] = [], at?: TransitRef): JourneyEndpoint => {
      if (typeof value !== 'string') return value;
      const stations = [value, ...place];
      const used = stations.find(ref => at === ref || stopRows.get(at!)?.parentStationRef === ref) ?? stations.find(serves);
      if (used) return used;
      const stop = stopRows.get(value);
      return stop?.latitude != null && stop.longitude != null ? { latitude: stop.latitude, longitude: stop.longitude } : value;
    };
    const realtime = query.realtimeFor ? await query.realtimeFor(routeRefs, feedIds) : query.realtime;
    if (realtime === null) { reasons.add('REALTIME_UNAVAILABLE'); continue; }
    try {
      const result = await planJourney({ ...query, readShard, realtime, origin: endpoint(query.origin, query.originStops, proposal.rides[0]?.from), destination: endpoint(query.destination, query.destinationStops, proposal.rides.at(-1)?.to), feedIds, routeRefs,
        agencyRefs: [...new Set([...routeRefs].map(ref => routes.get(ref)!.agencyRef))], windowSeconds: Math.max(60, Math.ceil(end - begin)), readConcurrency: 8 }, signal);
      count('exactPlans');
      result.reasons.forEach(reason => reasons.add(reason));
      rounds = Math.max(rounds, result.diagnostics.rounds); workingSet = Math.max(workingSet, result.diagnostics.estimatedWorkingSetBytes);
      // Each itinerary keeps the query it was validated under (endpoints as planned, the
      // narrowed window), so a later recheck validates exactly what was returned.
      candidates.push(...result.candidates);
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Planner working-set budget exceeded'))) throw error;
      count('exactOverBudget');
    }
  }
  // Each itinerary was validated by its own exact search. The same trips found twice (by
  // different walks) are one journey; keep the least walking. Then, earliest first, drop
  // those another beats on changes, walking or leaving later without arriving later
  // (planJourney's rule, plus waiting), and offer each sequence of lines once before a
  // later train on the same lines.
  const trips = (candidate: Itinerary) => candidate.legs.flatMap(leg => leg.kind === 'transit' ? [leg.tripInstanceRef] : []).join('|');
  const lines = (candidate: Itinerary) => candidate.legs.flatMap(leg => leg.kind === 'transit' ? [leg.routeRef] : []).join('|');
  // Equal arrivals: the later departure waits less.
  const ordered = candidates.sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime) || a.transfers - b.transfers || a.walkingMetres - b.walkingMetres ||
    Date.parse(b.departureTime) - Date.parse(a.departureTime));
  const unique: Itinerary[] = [], seenTrips = new Set<string>();
  for (const candidate of ordered) if (!seenTrips.has(trips(candidate))) { seenTrips.add(trips(candidate)); unique.push(candidate); }
  const dominated = (candidate: Itinerary, by: Itinerary[]) => by.some(other => Date.parse(other.arrivalTime) <= Date.parse(candidate.arrivalTime) &&
    Date.parse(other.departureTime) >= Date.parse(candidate.departureTime) && other.transfers <= candidate.transfers && other.walkingMetres <= candidate.walkingMetres &&
    (other.transfers < candidate.transfers || other.walkingMetres < candidate.walkingMetres || Date.parse(other.departureTime) > Date.parse(candidate.departureTime)));
  const open = unique.filter(candidate => !dominated(candidate, unique));
  const kept: Itinerary[] = [];
  for (const candidate of open) if (kept.length < 3 && !kept.some(other => lines(other) === lines(candidate))) kept.push(candidate);
  for (const candidate of open) if (kept.length < 3 && !kept.includes(candidate)) kept.push(candidate);
  kept.sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime) || a.transfers - b.transfers);
  if (!kept.length) return null;
  return { status: kept.some(candidate => candidate.status === 'realtime') ? 'realtime' : 'scheduled_only', reasons: [...reasons], candidates: kept,
    diagnostics: { rounds, estimatedWorkingSetBytes: workingSet } };
}
