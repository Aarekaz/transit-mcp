import { ProtocolError, ProtocolErrorCode, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext, TransitRequestState } from '../../context';
import { complete } from '../../shared';
import { getCoverage, getCoverages, type CoverageManifest } from '../../../transit/core/coverage';
import { getCoverageMode } from '../../../regions/manifest';
import { formatEntityRef, parseTransitRef, type TransitRef } from '../../../transit/core/refs';
import { VERIFICATION_REASONS, type SourceStatus, type VerificationReason } from '../../../transit/core/results';
import { StaticArtifactStore, readBoundedObject, sameStaticVersion, type StaticVersion } from '../../../transit/gtfs/realtime/snapshot-store';
import { credential, getRealtimeSource, publishedKinds } from '../../../transit/gtfs/realtime/sources';
import type { CoverageCapability } from '../../../transit/core/coverage';
import { decodeDiscoveryIndex, decodeScheduleShard, sha256 } from '../../../transit/gtfs/static/shards';
import type { ArtifactManifestV2, DiscoveryIndex, ScheduleStop } from '../../../transit/gtfs/static/schema';
import { stationAccess, stepFreeStops, type EquipmentOutage } from '../../../transit/accessibility/equipment';
import { kindThresholds, type FeedRead } from '../../../transit/gtfs/realtime/hub-core';
import type { NormalizedVehicle } from '../../../transit/gtfs/realtime/decode';
import type { RealtimeFeedKind } from '../../../regions/types';
import { classifyManifestFreshness, sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { serviceDateAtInstant } from '../../../transit/planner/service-day';
import { parseGtfsTime } from '../../../transit/gtfs/static/time';

export const boundedText = z.string().trim().min(1).max(256);
export const coverageSchema = boundedText.describe('Runtime coverage name or identifier; use find_transit to inspect availability.');
export const instantSchema = z.iso.datetime({ offset: true });
export const coordinatesSchema = z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
export const endpointSchema = z.union([z.strictObject({ ref: boundedText }), z.strictObject({ query: boundedText }), coordinatesSchema]);
export const sourceSchema = z.strictObject({ feedId: z.string(), kind: z.enum(['gtfs_schedule', 'trip_updates', 'vehicle_positions', 'alerts', 'equipment_outages', 'native_api']),
  producerTimestamp: instantSchema.nullable(), ingestedAt: instantSchema, ageSeconds: z.number().nonnegative().nullable(), scheduleVersion: z.string() });
export const attributionSchema = z.strictObject({ text: z.string(), url: z.url(), license: z.string().optional() });
export const resultShape = { status: z.enum(['realtime', 'scheduled_only', 'unavailable']), reasons: z.array(z.enum(VERIFICATION_REASONS)),
  asOf: instantSchema, sources: z.array(sourceSchema), attribution: z.array(attributionSchema) };
export const candidateSchema = z.strictObject({ ref: z.string(), kind: z.enum(['agency', 'route', 'stop', 'trip']),
  name: z.string(), coverage: z.string(), feed: z.string(), providerId: z.string(), endpoint: z.enum(['origin', 'destination']).optional() });
export type Candidate = z.infer<typeof candidateSchema>;
/** Per endpoint/query; two-endpoint elicitation is therefore at most 100 choices. */
export const MAX_DISCOVERY_CANDIDATES = 50;
export const errorSchema = z.strictObject({ code: z.enum(['ENTITY_NOT_FOUND', 'ENTITY_AMBIGUOUS', 'INVALID_TRANSIT_REF', 'INVALID_ITINERARY', 'TIME_OUTSIDE_WINDOW', 'SELECTION_DECLINED']),
  message: z.string(), candidates: z.array(candidateSchema).max(2 * MAX_DISCOVERY_CANDIDATES) });
export class TransitToolError extends Error {
  constructor(readonly code: z.infer<typeof errorSchema>['code'], readonly candidates: Candidate[] = []) { super(code); }
}
const messages = {
  ENTITY_NOT_FOUND: 'No matching transit entity was found. Use find_transit to choose a reference.',
  ENTITY_AMBIGUOUS: 'Choose an exact reference from the candidates and retry.',
  INVALID_TRANSIT_REF: 'Use a reference of the kind required by this tool, returned by find_transit or get_departures.',
  INVALID_ITINERARY: 'Pass an itinerary exactly as plan_trip returned it, without edits.',
  TIME_OUTSIDE_WINDOW: 'Narrow the search window or filters; the window must be between one second and seven days and within the candidate budget.',
  SELECTION_DECLINED: 'Transit entity selection was declined or cancelled.',
};
export function errorResult(error: TransitToolError) {
  return { ...complete(errorSchema.parse({ code: error.code, message: `${error.code}: ${messages[error.code]}`, candidates: error.candidates })), isError: true as const };
}
export function checkState(handler: ServerContext, tool: string): TransitRequestState | undefined {
  const state = handler.mcpReq.requestState<TransitRequestState>();
  if (state && state.tool !== tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Transit selection state does not match this request');
  return state;
}
export function metadata(coverageId?: string, data?: TransitData, asOf = new Date().toISOString()) {
  return { asOf, sources: data ? scheduleSources(data) : [], attribution: [...(getCoverage(coverageId ?? '')?.attribution ?? [])] };
}
export function unavailable(coverageId?: string, data?: TransitData, reasons: VerificationReason[] = ['COVERAGE_UNAVAILABLE']) {
  return { ...metadata(coverageId, data), status: 'unavailable' as const, reasons };
}
export async function guarded<T>(handler: ServerContext, operation: () => Promise<T>, fallback: () => T): Promise<T | ReturnType<typeof errorResult>> {
  try { handler.mcpReq.signal.throwIfAborted(); return await operation(); }
  catch (error) {
    if (ProtocolError.isInstance(error) || handler.mcpReq.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    if (error instanceof TransitToolError) return errorResult(error);
    if (error instanceof Error && error.message.startsWith('TIME_OUTSIDE_WINDOW:')) return errorResult(new TransitToolError('TIME_OUTSIDE_WINDOW'));
    return fallback();
  }
}
export interface TransitData {
  coverage: CoverageManifest; manifest: ArtifactManifestV2; version: StaticVersion; indexes: DiscoveryIndex[];
  readObject: (key: string) => Promise<Uint8Array>;
}
/** One store per bucket and coverage keeps the resident manifest across requests; the
 * pointer is still read every time, so a new version is seen immediately. */
const artifactStores = new WeakMap<R2Bucket, Map<string, StaticArtifactStore>>();
function artifactStore(bucket: R2Bucket, coverageId: string): StaticArtifactStore {
  let stores = artifactStores.get(bucket);
  if (!stores) { stores = new Map(); artifactStores.set(bucket, stores); }
  let store = stores.get(coverageId);
  if (!store) { store = new StaticArtifactStore(bucket, coverageId); stores.set(coverageId, store); }
  return store;
}
/** Verified, content-addressed discovery indexes per bound bucket (one store never vouches for another). */
const discoveryCaches = new WeakMap<R2Bucket, Map<string, DiscoveryIndex>>();
/** Public mode checks belong at the data boundary; catalog registration never changes. */
export async function loadData(context: MetroMcpContext, coverageId: string, signal: AbortSignal, version?: string): Promise<TransitData | null> {
  const coverage = getCoverage(coverageId);
  if (!coverage || getCoverageMode(coverage.id, context.env) !== 'on' || !context.env.TRANSIT_ARTIFACTS) return null;
  const bucket = context.env.TRANSIT_ARTIFACTS, store = artifactStore(bucket, coverage.id);
  signal.throwIfAborted();
  const current = version ? await store.read(version) : await store.current();
  signal.throwIfAborted();
  if (!current) return null;
  const readObject = async (key: string) => { signal.throwIfAborted(); const bytes = await readBoundedObject(bucket, key, 64 * 1024 * 1024); signal.throwIfAborted(); return bytes; };
  const indexes: DiscoveryIndex[] = []; let total = 0;
  for (const descriptor of current.manifest.discoveries) {
    total += descriptor.byteLength;
    if (total > 64 * 1024 * 1024) throw new Error('Discovery budget');
    let discoveryCache = discoveryCaches.get(bucket);
    if (!discoveryCache) { discoveryCache = new Map(); discoveryCaches.set(bucket, discoveryCache); }
    let index = discoveryCache.get(descriptor.sha256);
    if (!index) {
      const bytes = await readObject(descriptor.key);
      if (bytes.length !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Discovery integrity');
      index = decodeDiscoveryIndex(bytes);
      // Content-addressed and verified: safe to reuse across requests in this isolate.
      discoveryCache.set(descriptor.sha256, index);
      while (discoveryCache.size > 4) discoveryCache.delete(discoveryCache.keys().next().value!);
    }
    if (index.coverageId !== coverage.id || index.feedId !== descriptor.feedId || index.sourceSha256 !== current.version.sourceVersions[index.feedId]) throw new Error('Discovery identity');
    indexes.push(index);
  }
  return { ...current, coverage, indexes, readObject };
}
export function scheduleSources(data: TransitData): SourceStatus[] {
  return data.manifest.sources.map(source => ({ feedId: source.feedId, kind: 'gtfs_schedule', producerTimestamp: null,
    ingestedAt: source.retrievedAt, ageSeconds: null, scheduleVersion: source.sha256 }));
}
export function validRef(value: string, kinds: string[], dated = false): NonNullable<ReturnType<typeof parseTransitRef>> {
  const parsed = parseTransitRef(value);
  if (!parsed || !kinds.includes(parsed.kind) || (dated && parsed.kind === 'trip' && !('serviceDate' in parsed))) throw new TransitToolError('INVALID_TRANSIT_REF');
  return parsed;
}
/** Entities of one verified discovery index, built once: the index is immutable and
 * content-addressed, so the list, reference map and normalized names never change. */
interface EntityIndex { list: readonly Candidate[]; byRef: Map<string, Candidate>; names: Map<string, readonly string[]> }
const entityIndexes = new WeakMap<DiscoveryIndex, Map<string, EntityIndex>>();
function entityIndex(data: TransitData, index: DiscoveryIndex): EntityIndex {
  const agencies = Object.keys(data.manifest.agencyTimezones).filter(ref => parseTransitRef(ref)?.feed === index.feedId).sort();
  const key = agencies.join('\n');
  let byAgencies = entityIndexes.get(index);
  const cached = byAgencies?.get(key);
  if (cached) return cached;
  const routes = new Map(index.routes.map(route => [route.ref as string, route]));
  const list = [
    ...index.stops.map(stop => ({ ref: stop.ref, providerId: stop.providerId, name: sanitizeTransitText(stop.name), kind: 'stop' as const })),
    ...index.routes.map(route => ({ ref: route.ref, providerId: route.providerId, name: sanitizeTransitText(`${route.shortName} ${route.longName}`.trim()), kind: 'route' as const })),
    ...index.tripProviderIds.map(id => ({ ref: formatEntityRef({ coverage: index.coverageId, feed: index.feedId, kind: 'trip', id }), providerId: id, name: sanitizeTransitText(id), kind: 'trip' as const })),
    ...agencies.map(ref => ({ ref, providerId: parseTransitRef(ref)!.id, name: sanitizeTransitText(parseTransitRef(ref)!.id), kind: 'agency' as const })),
  ].map(entity => Object.freeze({ ...entity, coverage: index.coverageId, feed: index.feedId }) as Candidate);
  const names = new Map(list.map(entity => {
    const route = entity.kind === 'route' ? routes.get(entity.ref) : undefined;
    return [entity.ref, Object.freeze([entity.providerId, entity.name, route?.shortName ?? '', route?.longName ?? ''].filter(Boolean).map(normalizeEntityName))] as const;
  }));
  const built: EntityIndex = { list: Object.freeze(list), byRef: new Map(list.map(entity => [entity.ref, entity])), names };
  if (!byAgencies) { byAgencies = new Map(); entityIndexes.set(index, byAgencies); }
  byAgencies.set(key, built);
  return built;
}
export function entities(data: TransitData): readonly Candidate[] {
  return data.indexes.length === 1 ? entityIndex(data, data.indexes[0]!).list : data.indexes.flatMap(index => entityIndex(data, index).list);
}
export function candidates(data: TransitData, query: string, kind?: string): Candidate[] {
  const normalized = normalizeEntityName(query), aliasStops = aliasStopNames(data, normalized);
  const found: { entity: Candidate; exact: boolean }[] = [];
  for (const index of data.indexes) {
    const { list, names } = entityIndex(data, index);
    for (const entity of list) {
      if (kind && kind !== entity.kind) continue;
      const own = names.get(entity.ref)!, alias = aliasMatch(entity, aliasStops);
      if (alias || own.some(name => name.includes(normalized))) found.push({ entity, exact: alias || own.includes(normalized) });
    }
  }
  return found.sort((a, b) => Number(b.exact) - Number(a.exact) || a.entity.providerId.localeCompare(b.entity.providerId) || a.entity.ref.localeCompare(b.entity.ref))
    .map(item => item.entity);
}
const normalizeEntityName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function entityNames(data: TransitData, entity: Candidate): readonly string[] {
  const index = data.indexes.find(index => index.feedId === entity.feed);
  return (index && entityIndex(data, index).names.get(entity.ref)) ?? [entity.providerId, entity.name].filter(Boolean).map(normalizeEntityName);
}
/** Normalized stop names a reviewed public place alias stands for (empty when none match). */
function aliasStopNames(data: TransitData, normalized: string): Set<string> {
  return new Set((data.coverage.placeAliases ?? []).filter(place => place.aliases.some(alias => normalizeEntityName(alias) === normalized))
    .flatMap(place => place.stopNames.map(normalizeEntityName)));
}
const aliasMatch = (entity: Candidate, aliasStops: Set<string>) => entity.kind === 'stop' && aliasStops.size > 0 && aliasStops.has(normalizeEntityName(entity.name));
function placeAliasMatch(data: TransitData, entity: Candidate, normalized: string): boolean {
  return aliasMatch(entity, aliasStopNames(data, normalized));
}
export const exactCandidate = (data: TransitData, entity: Candidate, query: string) =>
  entityNames(data, entity).includes(normalizeEntityName(query)) || placeAliasMatch(data, entity, normalizeEntityName(query));
/** A public place alias must not hide separately named stops, such as airport terminals. */
export function ambiguityCandidate(data: TransitData, entity: Candidate, query: string): boolean {
  const normalized = normalizeEntityName(query);
  return exactCandidate(data, entity, query) || entity.kind === 'stop' && normalizeEntityName(entity.name).includes(normalized) &&
    (data.coverage.placeAliases ?? []).some(place => place.aliases.some(alias => normalizeEntityName(alias) === normalized));
}
/** Matches that all belong to one station complex name one place, and resolve to its
 * station. A complex is a GTFS station with its platforms and entrances, together with
 * same-named stations published separately within a short walk (for example the four
 * "Times Sq-42 St" stations). Same-named stations farther apart stay separate candidates. */
export const COMPLEX_RADIUS_METRES = 200;
/** Groups same-named stations into complexes: the publisher links them with a transfer,
 * or they lie within a short walk of each other. Maps each station to its complex's first station. */
function stationComplexes(data: TransitData, roots: string[]): Map<string, string> {
  const stops = stopsByRef(data);
  const metres = (a: ScheduleStopLike, b: ScheduleStopLike) => {
    if (a.latitude === null || a.longitude === null || b.latitude === null || b.longitude === null) return Infinity;
    const radians = Math.PI / 180, x = (b.longitude - a.longitude) * radians * Math.cos((a.latitude + b.latitude) * radians / 2), y = (b.latitude - a.latitude) * radians;
    return Math.hypot(x, y) * 6_371_000;
  };
  roots = [...new Set(roots)].sort();
  const linked = new Set(data.indexes.flatMap(index => index.stationLinks ?? []).map(([a, b]) => `${a}\n${b}`));
  const parent = new Map(roots.map(root => [root, root]));
  const find = (root: string): string => { let at = root; while (parent.get(at) !== at) at = parent.get(at)!; return at; };
  for (const [index, a] of roots.entries()) for (const b of roots.slice(index + 1)) {
    const left = stops.get(a)!, right = stops.get(b)!;
    if (normalizeEntityName(left.name) !== normalizeEntityName(right.name)) continue;
    if (linked.has(`${a}\n${b}`) || metres(left, right) <= COMPLEX_RADIUS_METRES) {
      const [x, y] = [find(a), find(b)].sort() as [string, string];
      parent.set(y, x);
    }
  }
  return new Map(roots.map(root => [root, find(root)]));
}
const stopMaps = new WeakMap<TransitData['indexes'], Map<string, ScheduleStop>>();
function stopsByRef(data: TransitData): Map<string, ScheduleStop> {
  let stops = stopMaps.get(data.indexes);
  if (!stops) { stops = new Map(data.indexes.flatMap(index => index.stops).map(stop => [stop.ref as string, stop])); stopMaps.set(data.indexes, stops); }
  return stops;
}
function stationOf(data: TransitData, ref: string): string | undefined {
  const stop = stopsByRef(data).get(ref);
  return stop?.locationType === 1 ? ref : stop?.parentStationRef;
}
export function sameStation(data: TransitData, matches: Candidate[]): Candidate[] {
  if (matches.length < 2) return matches;
  const complex = stationComplexes(data, matches.flatMap(match => { const root = match.kind === 'stop' ? stationOf(data, match.ref) : undefined; return root ? [root] : []; }));
  // One candidate per place, in the original rank order; a place is its complex's first station.
  const seen = new Set<string>(), result: Candidate[] = [];
  for (const match of matches) {
    const root = match.kind === 'stop' ? stationOf(data, match.ref) : undefined;
    if (!root) { result.push(match); continue; }
    const place = complex.get(root)!;
    if (seen.has(place)) continue;
    seen.add(place);
    result.push(matches.find(candidate => candidate.ref === place) ?? match);
  }
  return result;
}
/** The name riders use for a route: its short name ("A", "7"), unless that is only the
 * initial of the long name, as WMATA publishes "R" for "Red". */
export function routeName(route: { shortName: string; longName: string }): string {
  const initial = route.shortName.length === 1 && route.longName.toUpperCase().startsWith(route.shortName.toUpperCase());
  return sanitizeTransitText(!route.shortName || initial ? route.longName || route.shortName : route.shortName, 120);
}
/** The other stations in a station's complex (Times Sq-42 St is published as four). */
export function complexStations(data: TransitData, stationRef: string): string[] {
  const station = stopsByRef(data).get(stationRef);
  if (station?.locationType !== 1) return [];
  const name = normalizeEntityName(station.name);
  const sameName = data.indexes.flatMap(index => index.stops).filter(stop => stop.locationType === 1 && normalizeEntityName(stop.name) === name).map(stop => stop.ref as string);
  const complex = stationComplexes(data, sameName), place = complex.get(stationRef);
  return sameName.filter(ref => ref !== stationRef && complex.get(ref) === place).sort();
}
type ScheduleStopLike = { latitude: number | null; longitude: number | null };
export function knownEntity(data: TransitData, ref: string): Candidate {
  const parsed = validRef(ref, ['agency', 'route', 'stop', 'trip']);
  const base = formatEntityRef(parsed);
  const index = data.indexes.find(index => index.feedId === parsed.feed);
  const entity = index && entityIndex(data, index).byRef.get(base);
  if (!entity) throw new TransitToolError('ENTITY_NOT_FOUND');
  return { ...entity, ref };
}
export async function detail(data: TransitData, ref: string) {
  const entity = knownEntity(data, ref), parsed = parseTransitRef(ref)!;
  const index = data.indexes.find(index => index.feedId === entity.feed)!;
  const stop = index.stops.find(stop => stop.ref === entity.ref);
  const route = index.routes.find(route => route.ref === entity.ref);
  const patterns: { id: string; directionId: number | null; stopRefs: string[] }[] = [];
  const calls: { stopRef: string; sequence: number; arrivalSeconds: number | null; departureSeconds: number | null; pickupType: number; dropOffType: number }[] = [];
  if (entity.kind === 'route' || entity.kind === 'trip') {
    // Decode one shard at a time: bounded per object, never a whole artifact at once.
    const timezone = Object.entries(data.manifest.agencyTimezones).find(([ref]) => parseTransitRef(ref)?.feed === entity.feed)?.[1];
    const today = timezone ? serviceDateAtInstant(Date.now(), timezone) : undefined;
    const day = 'serviceDate' in parsed ? parsed.serviceDate : today;
    const start = 'startTime' in parsed ? parseGtfsTime(parsed.startTime).totalSeconds : undefined;
    const descriptors = data.manifest.shards.filter(shard => shard.feedId === entity.feed && (!shard.timeRange || day === undefined || day >= shard.window.startDate && day <= shard.window.endDate) &&
      (!('serviceDate' in parsed) || parsed.serviceDate >= shard.window.startDate && parsed.serviceDate <= shard.window.endDate) &&
      (start === undefined || !shard.timeRange || start >= shard.timeRange.bandStart && start < shard.timeRange.bandEnd));
    let total = 0;
    for (const descriptor of descriptors) {
      total += descriptor.byteLength;
      if (descriptor.byteLength > 8 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error('Detail budget');
      const bytes = await data.readObject(descriptor.key);
      if (bytes.length !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Detail integrity');
      const shard = decodeScheduleShard(bytes);
      if (shard.source.sha256 !== data.version.sourceVersions[entity.feed] || shard.feedId !== entity.feed || shard.coverageId !== entity.coverage) throw new Error('Detail identity');
      for (const pattern of shard.patterns.filter(pattern => pattern.routeRef === ref)) {
        if (!patterns.some(value => value.id === pattern.id)) patterns.push({ id: pattern.id, directionId: pattern.directionId, stopRefs: pattern.stopRefs });
      }
      const trip = shard.trips.find(trip => trip.providerId === entity.providerId && entity.kind === 'trip');
      if (trip && !calls.length) calls.push(...trip.stopTimes.map(call => ({ stopRef: call.stopRef, sequence: call.sequence,
        arrivalSeconds: call.arrivalSeconds, departureSeconds: call.departureSeconds, pickupType: call.pickupType, dropOffType: call.dropOffType })));
    }
  }
  return { ...entity, scheduleVersion: data.version.artifactVersion, resourceUri: `transit://entity/${ref}?version=${data.version.artifactVersion}`,
    coordinates: stop?.latitude != null && stop.longitude != null ? { latitude: stop.latitude, longitude: stop.longitude } : null,
    routeRefs: stop ? index.stopRoutes[stop.ref] ?? [] : [], agencyRef: route?.agencyRef ?? null, mode: route?.mode ?? null, patterns, calls,
    stepFree: stop ? stationAccess(index, stop, stopsByRef(data)) : null };
}
/** Source support narrowed to what this deployment can serve now: realtime kinds need
 * a bound coordinator, any required credential, and an ingested feed of that kind. */
export function effectiveCapabilities(context: MetroMcpContext, coverage: CoverageManifest, requireCredential = true): CoverageCapability {
  const source = getRealtimeSource(coverage.id);
  const ingests = (kind: RealtimeFeedKind) => !!source && !!context.env.REGION_FEED_HUB && (!requireCredential || credential(source, context.env) !== null) &&
    publishedKinds(source).has(kind);
  return { ...coverage.capabilities,
    realtimeDepartures: coverage.capabilities.realtimeDepartures && ingests('trip_updates'),
    alerts: coverage.capabilities.alerts && ingests('service_alerts'),
    vehicles: coverage.capabilities.vehicles && ingests('vehicle_positions'),
    accessibility: coverage.capabilities.accessibility && ingests('equipment_outages') };
}
/** Each coverage's coordinator owns exactly one static feed's realtime. */
export type OwnedFeedRead<T> = FeedRead<T> & { feedId: string; reasons: VerificationReason[] };
export async function readFeed<T>(context: MetroMcpContext, data: TransitData, kind: RealtimeFeedKind, now: number, signal: AbortSignal, stopIds: string[] = []): Promise<OwnedFeedRead<T[]>> {
  const source = getRealtimeSource(data.coverage.id);
  const feedId = source?.policy.feedId ?? data.manifest.sources[0]?.feedId ?? '';
  const missing = (): OwnedFeedRead<T[]> => ({ feedId, freshness: 'unavailable', status: kind === 'trip_updates' ? 'scheduled_only' : 'unavailable', payload: null, warnings: [], reasons: ['REALTIME_UNAVAILABLE'] });
  const capability = kind === 'trip_updates' ? 'realtimeDepartures' : kind === 'vehicle_positions' ? 'vehicles' : kind === 'equipment_outages' ? 'accessibility' : 'alerts';
  if (!source || !context.env.REGION_FEED_HUB || !effectiveCapabilities(context, data.coverage, false)[capability]) return missing();
  // Without a credential the coordinator publishes nothing, so reads degrade by freshness.
  const url = new URL(`https://region-feed-hub.internal/${kind}`);
  url.searchParams.set('now', String(now)); url.searchParams.set('artifact', data.version.artifactVersion);
  for (const stop of kind === 'trip_updates' ? stopIds.slice(0, 200) : []) url.searchParams.append('stop', stop);
  signal.throwIfAborted();
  try {
    const response = await context.env.REGION_FEED_HUB.get(context.env.REGION_FEED_HUB.idFromName(source.policy.namespace)).fetch(url.href, { signal });
    signal.throwIfAborted();
    if (!response.ok) return missing();
    const feed = await response.json<FeedRead<T[]>>();
    const policy = data.coverage.thresholds;
    const { fresh: threshold, expired: expiry } = kindThresholds(policy, kind);
    const validStamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now;
    const producerTimestampSeconds = validStamp(feed.producerTimestampSeconds) ? feed.producerTimestampSeconds : undefined;
    const receivedAtSeconds = validStamp(feed.receivedAtSeconds) ? feed.receivedAtSeconds : undefined;
    const freshness = classifyManifestFreshness(producerTimestampSeconds, now, threshold, expiry);
    const mismatch = !!feed.version && (!sameStaticVersion(feed.version, data.version) || !data.version.sourceVersions[feedId]);
    const reasons: VerificationReason[] = mismatch || feed.warnings?.includes('SCHEDULE_REALTIME_MISMATCH') ? ['SCHEDULE_REALTIME_MISMATCH'] :
      feed.degraded || !feed.version || freshness === 'expired' || freshness === 'unavailable' || receivedAtSeconds === undefined || receivedAtSeconds < (producerTimestampSeconds ?? Infinity) || !Array.isArray(feed.payload) ? ['REALTIME_UNAVAILABLE'] :
      freshness === 'stale' ? ['REALTIME_STALE'] : [];
    const usable = reasons.length === 0 || (kind === 'service_alerts' || kind === 'equipment_outages') && reasons[0] === 'REALTIME_STALE';
    return { ...feed, feedId, reasons, warnings: [], producerTimestampSeconds, receivedAtSeconds, freshness,
      status: usable ? 'realtime' : kind === 'trip_updates' ? 'scheduled_only' : 'unavailable', payload: usable ? feed.payload : null };
  } catch (error) { signal.throwIfAborted(); if (error instanceof Error && error.name === 'AbortError') throw error; return missing(); }
}
/** Platforms a step-free journey may use now, or why none can be claimed: the coverage
 * must publish station accessibility and a current (not stale) equipment report. */
export async function stepFreeAccess(context: MetroMcpContext, data: TransitData, now: number, signal: AbortSignal):
  Promise<{ usable: Set<string> | null; outages: EquipmentOutage[]; reasons: VerificationReason[]; sources: SourceStatus[] }> {
  if (!effectiveCapabilities(context, data.coverage, false).accessibility) return { usable: null, outages: [], reasons: ['ACCESSIBILITY_UNAVAILABLE'], sources: [] };
  const feed = await readFeed<EquipmentOutage>(context, data, 'equipment_outages', now, signal);
  const sources = realtimeSource(data, feed, 'equipment_outages', now);
  if (feed.status !== 'realtime' || feed.freshness !== 'fresh' || !feed.payload) return { usable: null, outages: feed.payload ?? [], reasons: ['ACCESSIBILITY_UNAVAILABLE', ...feed.reasons], sources };
  const usable = new Set<string>();
  for (const index of data.indexes) for (const ref of stepFreeStops(index, feed.payload, now)) usable.add(ref);
  return { usable, outages: feed.payload, reasons: [], sources };
}
/** Train numbers are observations, not schedule entities. Resolve one only from a fresh
 * vehicle feed, to the dated trip instance that train is running; never guess. */
export async function trainCandidates(context: MetroMcpContext, data: TransitData, query: string, signal: AbortSignal): Promise<{ candidates: Candidate[]; sources: SourceStatus[] }> {
  // A DC train number (`644`) or an NYCT train ID (`1A 1023 207/FAR`), compared case- and spacing-insensitively.
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();
  const number = normalize(query.replace(/^\s*train\s+/i, ''));
  if (!/^[A-Z0-9 +/.-]{1,32}$/.test(number) || !effectiveCapabilities(context, data.coverage, false).vehicles) return { candidates: [], sources: [] };
  const now = Math.floor(Date.now() / 1000);
  const feed = await readFeed<NormalizedVehicle>(context, data, 'vehicle_positions', now, signal);
  const maxAge = data.coverage.thresholds.vehiclePositions.realtimeSeconds;
  const candidates = new Map<string, Candidate>();
  for (const vehicle of feed.status === 'realtime' ? feed.payload ?? [] : []) {
    const age = vehicle.timestampSeconds === undefined ? Infinity : now - vehicle.timestampSeconds;
    if (!vehicle.tripInstanceRef || age < 0 || age > maxAge || ![vehicle.vehicleId, vehicle.label, vehicle.trainId].some(id => id !== undefined && normalize(id) === number)) continue;
    const instance = parseTransitRef(vehicle.tripInstanceRef);
    if (!instance || instance.kind !== 'trip') continue;
    candidates.set(vehicle.tripInstanceRef, { ref: vehicle.tripInstanceRef, kind: 'trip', name: sanitizeTransitText(`Train ${vehicle.trainId ?? vehicle.vehicleId ?? vehicle.label}`),
      coverage: instance.coverage, feed: instance.feed, providerId: instance.id });
  }
  return { candidates: [...candidates.values()].sort((a, b) => a.ref.localeCompare(b.ref)), sources: candidates.size ? realtimeSource(data, feed, 'vehicle_positions', now) : [] };
}
/** Rows the schedule planner and validator may use: calls of canonical trip instances. */
export function scheduledRealtimeRows<T extends { scheduleMatch?: string }>(rows: T[] | null): T[] | null {
  return rows && rows.filter(row => row.scheduleMatch === undefined || row.scheduleMatch === 'matched');
}
export function realtimeSource(_data: TransitData, feed: OwnedFeedRead<unknown>, kind: SourceStatus['kind'], now: number): SourceStatus[] {
  const scheduleVersion = feed.version?.sourceVersions[feed.feedId];
  if (!scheduleVersion || feed.receivedAtSeconds === undefined) return [];
  return [{ feedId: feed.feedId, kind, producerTimestamp: feed.producerTimestampSeconds == null ? null : new Date(feed.producerTimestampSeconds * 1000).toISOString(),
    ingestedAt: new Date(feed.receivedAtSeconds * 1000).toISOString(), ageSeconds: feed.producerTimestampSeconds == null ? null : Math.max(0, now - feed.producerTimestampSeconds), scheduleVersion }];
}
export function inferCoverage(endpoint: z.infer<typeof endpointSchema>): string | undefined {
  if ('ref' in endpoint) return validRef(endpoint.ref, ['stop']).coverage;
  if ('latitude' in endpoint) {
    const matches = getCoverages().filter(coverage => {
      const bounds = coverage.bounds;
      return bounds && endpoint.longitude >= bounds[0] && endpoint.latitude >= bounds[1] && endpoint.longitude <= bounds[2] && endpoint.latitude <= bounds[3];
    });
    // Overlapping coverage bounds cannot establish identity by registry order.
    if (matches.length === 1) return matches[0]!.id;
  }
  return undefined;
}
export const asTransitRef = (ref: string) => ref as TransitRef;
