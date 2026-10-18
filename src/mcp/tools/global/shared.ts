import { ProtocolError, ProtocolErrorCode, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext, TransitRequestState } from '../../context';
import { complete } from '../../shared';
import { getCoverage, getCoverages, type CoverageManifest } from '../../../transit/core/coverage';
import { getCoverageMode } from '../../../regions/manifest';
import { formatEntityRef, parseTransitRef, type TransitRef } from '../../../transit/core/refs';
import { VERIFICATION_REASONS, type SourceStatus, type VerificationReason } from '../../../transit/core/results';
import { StaticArtifactStore, readBoundedObject, sameStaticVersion, SF511_QUOTA_NAMESPACE, type StaticVersion } from '../../../transit/gtfs/realtime/snapshot-store';
import { decodeDiscoveryIndex, decodeScheduleShard, sha256 } from '../../../transit/gtfs/static/shards';
import type { ArtifactManifestV2, DiscoveryIndex } from '../../../transit/gtfs/static/schema';
import type { FeedRead } from '../../../transit/gtfs/realtime/hub-core';
import type { RealtimeFeedKind } from '../../../regions/types';
import { classifyManifestFreshness, sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';

export const boundedText = z.string().trim().min(1).max(256);
export const coverageSchema = boundedText.describe('Runtime coverage name or identifier; use find_transit to inspect availability.');
export const instantSchema = z.iso.datetime({ offset: true });
export const coordinatesSchema = z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
export const endpointSchema = z.union([z.strictObject({ ref: boundedText }), z.strictObject({ query: boundedText }), coordinatesSchema]);
export const sourceSchema = z.strictObject({ feedId: z.string(), kind: z.enum(['gtfs_schedule', 'trip_updates', 'vehicle_positions', 'alerts', 'native_api']),
  producerTimestamp: instantSchema.nullable(), ingestedAt: instantSchema, ageSeconds: z.number().nonnegative().nullable(), scheduleVersion: z.string() });
export const attributionSchema = z.strictObject({ text: z.string(), url: z.url(), license: z.string().optional() });
export const resultShape = { status: z.enum(['realtime', 'scheduled_only', 'unavailable']), reasons: z.array(z.enum(VERIFICATION_REASONS)),
  asOf: instantSchema, sources: z.array(sourceSchema), attribution: z.array(attributionSchema) };
export const candidateSchema = z.strictObject({ ref: z.string(), kind: z.enum(['agency', 'route', 'stop', 'trip']),
  name: z.string(), coverage: z.string(), feed: z.string(), providerId: z.string(), endpoint: z.enum(['origin', 'destination']).optional() });
export type Candidate = z.infer<typeof candidateSchema>;
/** Per endpoint/query; two-endpoint elicitation is therefore at most 100 choices. */
export const MAX_DISCOVERY_CANDIDATES = 50;
export const errorSchema = z.strictObject({ code: z.enum(['ENTITY_NOT_FOUND', 'ENTITY_AMBIGUOUS', 'INVALID_TRANSIT_REF', 'TIME_OUTSIDE_WINDOW', 'SELECTION_DECLINED']),
  message: z.string(), candidates: z.array(candidateSchema).max(2 * MAX_DISCOVERY_CANDIDATES) });
export class TransitToolError extends Error {
  constructor(readonly code: z.infer<typeof errorSchema>['code'], readonly candidates: Candidate[] = []) { super(code); }
}
const messages = {
  ENTITY_NOT_FOUND: 'No matching transit entity was found. Use find_transit to choose a reference.',
  ENTITY_AMBIGUOUS: 'Choose an exact reference from the candidates and retry.',
  INVALID_TRANSIT_REF: 'Use a reference of the kind required by this tool, returned by find_transit or get_departures.',
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
/** Public mode checks belong at the data boundary; catalog registration never changes. */
export async function loadData(context: MetroMcpContext, coverageId: string, signal: AbortSignal, version?: string): Promise<TransitData | null> {
  const coverage = getCoverage(coverageId);
  if (!coverage || getCoverageMode(coverage.id, context.env) !== 'on' || !context.env.TRANSIT_ARTIFACTS) return null;
  const bucket = context.env.TRANSIT_ARTIFACTS, store = new StaticArtifactStore(bucket, coverage.id);
  signal.throwIfAborted();
  const current = version ? await store.read(version) : await store.current();
  signal.throwIfAborted();
  if (!current) return null;
  const readObject = async (key: string) => { signal.throwIfAborted(); const bytes = await readBoundedObject(bucket, key, 64 * 1024 * 1024); signal.throwIfAborted(); return bytes; };
  const indexes: DiscoveryIndex[] = []; let total = 0;
  for (const descriptor of current.manifest.discoveries) {
    total += descriptor.byteLength;
    if (total > 64 * 1024 * 1024) throw new Error('Discovery budget');
    const bytes = await readObject(descriptor.key);
    if (bytes.length !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Discovery integrity');
    const index = decodeDiscoveryIndex(bytes);
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
export function entities(data: TransitData): Candidate[] {
  return data.indexes.flatMap(index => [
    ...index.stops.map(stop => ({ ref: stop.ref, providerId: stop.providerId, name: sanitizeTransitText(stop.name), kind: 'stop' as const })),
    ...index.routes.map(route => ({ ref: route.ref, providerId: route.providerId, name: sanitizeTransitText(`${route.shortName} ${route.longName}`.trim()), kind: 'route' as const })),
    ...index.tripProviderIds.map(id => ({ ref: formatEntityRef({ coverage: index.coverageId, feed: index.feedId, kind: 'trip', id }), providerId: id, name: sanitizeTransitText(id), kind: 'trip' as const })),
    ...Object.keys(data.manifest.agencyTimezones).filter(ref => parseTransitRef(ref)?.feed === index.feedId).map(ref => ({ ref, providerId: parseTransitRef(ref)!.id, name: sanitizeTransitText(parseTransitRef(ref)!.id), kind: 'agency' as const })),
  ].map(entity => ({ ...entity, coverage: index.coverageId, feed: index.feedId })));
}
export function candidates(data: TransitData, query: string, kind?: string): Candidate[] {
  const normalized = normalizeEntityName(query);
  return entities(data).filter(entity => (!kind || kind === entity.kind) &&
    (entityNames(data, entity).some(name => name.includes(normalized)) || placeAliasMatch(data, entity, normalized)))
    .sort((a, b) => Number(exactCandidate(data, b, query)) - Number(exactCandidate(data, a, query)) || a.providerId.localeCompare(b.providerId) || a.ref.localeCompare(b.ref));
}
const normalizeEntityName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function entityNames(data: TransitData, entity: Candidate): string[] {
  const route = entity.kind === 'route' ? data.indexes.find(index => index.feedId === entity.feed)?.routes.find(route => route.ref === entity.ref) : undefined;
  return [entity.providerId, entity.name, route?.shortName ?? '', route?.longName ?? ''].filter(Boolean).map(normalizeEntityName);
}
function placeAliasMatch(data: TransitData, entity: Candidate, normalized: string): boolean {
  return entity.kind === 'stop' && (data.coverage.placeAliases ?? []).some(place =>
    place.aliases.some(alias => normalizeEntityName(alias) === normalized) &&
    place.stopNames.some(name => normalizeEntityName(name) === normalizeEntityName(entity.name)));
}
export const exactCandidate = (data: TransitData, entity: Candidate, query: string) =>
  entityNames(data, entity).includes(normalizeEntityName(query)) || placeAliasMatch(data, entity, normalizeEntityName(query));
/** A public place alias must not hide separately named stops, such as airport terminals. */
export function ambiguityCandidate(data: TransitData, entity: Candidate, query: string): boolean {
  const normalized = normalizeEntityName(query);
  return exactCandidate(data, entity, query) || entity.kind === 'stop' && normalizeEntityName(entity.name).includes(normalized) &&
    (data.coverage.placeAliases ?? []).some(place => place.aliases.some(alias => normalizeEntityName(alias) === normalized));
}
export function knownEntity(data: TransitData, ref: string): Candidate {
  const parsed = validRef(ref, ['agency', 'route', 'stop', 'trip']);
  const base = formatEntityRef(parsed);
  const entity = entities(data).find(entity => entity.ref === base);
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
    let total = 0;
    for (const descriptor of data.manifest.shards.filter(shard => shard.feedId === entity.feed && (!('serviceDate' in parsed) || parsed.serviceDate >= shard.window.startDate && parsed.serviceDate <= shard.window.endDate))) {
      total += descriptor.byteLength; if (total > 48 * 1024 * 1024 / 8) throw new Error('Detail budget');
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
    routeRefs: stop ? index.stopRoutes[stop.ref] ?? [] : [], agencyRef: route?.agencyRef ?? null, mode: route?.mode ?? null, patterns, calls };
}
/** This coordinator owns sf511 only; artifact membership does not imply realtime ownership. */
export type OwnedFeedRead<T> = FeedRead<T> & { feedId: string; reasons: VerificationReason[] };
export async function readFeed<T>(context: MetroMcpContext, data: TransitData, kind: RealtimeFeedKind, now: number, signal: AbortSignal): Promise<OwnedFeedRead<T[]>> {
  const missing = (): OwnedFeedRead<T[]> => ({ feedId: 'sf511', freshness: 'unavailable', status: kind === 'trip_updates' ? 'scheduled_only' : 'unavailable', payload: null, warnings: [], reasons: ['REALTIME_UNAVAILABLE'] });
  if (data.coverage.id !== 'sfbay' || !context.env.REGION_FEED_HUB) return missing();
  const url = new URL(`https://region-feed-hub.internal/${kind}`);
  url.searchParams.set('now', String(now)); url.searchParams.set('artifact', data.version.artifactVersion);
  signal.throwIfAborted();
  try {
    const response = await context.env.REGION_FEED_HUB.get(context.env.REGION_FEED_HUB.idFromName(SF511_QUOTA_NAMESPACE)).fetch(url.href, { signal });
    signal.throwIfAborted();
    if (!response.ok) return missing();
    const feed = await response.json<FeedRead<T[]>>();
    const policy = data.coverage.thresholds;
    const threshold = kind === 'trip_updates' ? policy.tripUpdates.realtimeSeconds : kind === 'vehicle_positions' ? policy.vehiclePositions.realtimeSeconds : policy.alerts.currentSeconds;
    const expiry = kind === 'trip_updates' ? policy.tripUpdates.staleSeconds : kind === 'vehicle_positions' ? policy.vehiclePositions.unavailableSeconds : Infinity;
    const validStamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now;
    const producerTimestampSeconds = validStamp(feed.producerTimestampSeconds) ? feed.producerTimestampSeconds : undefined;
    const receivedAtSeconds = validStamp(feed.receivedAtSeconds) ? feed.receivedAtSeconds : undefined;
    const freshness = classifyManifestFreshness(producerTimestampSeconds, now, threshold, expiry);
    const mismatch = !!feed.version && (!sameStaticVersion(feed.version, data.version) || !data.version.sourceVersions.sf511);
    const reasons: VerificationReason[] = mismatch || feed.warnings?.includes('SCHEDULE_REALTIME_MISMATCH') ? ['SCHEDULE_REALTIME_MISMATCH'] :
      feed.degraded || !feed.version || freshness === 'expired' || freshness === 'unavailable' || receivedAtSeconds === undefined || receivedAtSeconds < (producerTimestampSeconds ?? Infinity) || !Array.isArray(feed.payload) ? ['REALTIME_UNAVAILABLE'] :
      freshness === 'stale' ? ['REALTIME_STALE'] : [];
    const usable = reasons.length === 0 || kind === 'service_alerts' && reasons[0] === 'REALTIME_STALE';
    return { ...feed, feedId: 'sf511', reasons, warnings: [], producerTimestampSeconds, receivedAtSeconds, freshness,
      status: usable ? 'realtime' : kind === 'trip_updates' ? 'scheduled_only' : 'unavailable', payload: usable ? feed.payload : null };
  } catch (error) { signal.throwIfAborted(); if (error instanceof Error && error.name === 'AbortError') throw error; return missing(); }
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
