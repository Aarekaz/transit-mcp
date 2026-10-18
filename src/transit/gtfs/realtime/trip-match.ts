import { SFBAY_COVERAGE } from '../../../regions/sfbay';
import { formatTripInstanceRef, parseTransitRef } from '../../core/refs';
import { isServiceActive, serviceDayOrigin } from '../../planner/service-day';
import type { ArtifactManifestV2, DiscoveryIndex, ScheduleShard, ScheduleTrip } from '../static/schema';
import { canonicalJson, decodeDiscoveryIndex, encodeScheduleShard, sha256 } from '../static/shards';
import { parseGtfsTime, parseServiceDate } from '../static/time';
import type { DecodedStopUpdate, NormalizedRealtimeFeed, NormalizedStopUpdate, NormalizedTripUpdate, NormalizedVehicle } from './decode';
import { sameStaticVersion, staticVersion, type StaticVersion } from './snapshot-store';

export interface TripMatchContext { manifest: ArtifactManifestV2; shards: ScheduleShard[]; discoveries?: DiscoveryIndex[]; version: StaticVersion; feedId?: string }
export interface MatchedTripInstance {
  shard: ScheduleShard; trip: ScheduleTrip; timezone: string; serviceDate: string;
  startSeconds: number; shiftSeconds: number; originSeconds: number; tripInstanceRef: string;
}
export interface AppliedTripUpdates {
  version: StaticVersion; trips: NormalizedTripUpdate[]; stopUpdates: NormalizedStopUpdate[];
  match: { eligible: number; matched: number; rate: number }; degraded: boolean; warnings: string[];
}
function timeString(seconds: number): string {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function assertIdentity(context: TripMatchContext): void {
  const expected = Object.fromEntries(context.manifest.sources.map(source => [source.feedId, source.sha256]));
  if (canonicalJson(expected) !== canonicalJson(context.version.sourceVersions)) throw new Error('Realtime static source version mismatch');
  for (const shard of context.shards) {
    const source = context.manifest.sources.filter(source => source.feedId === shard.feedId);
    const timezones = Object.fromEntries(Object.entries(context.manifest.agencyTimezones).filter(([ref]) => parseTransitRef(ref)?.feed === shard.feedId));
    if (source.length !== 1 || shard.coverageId !== context.manifest.coverageId || canonicalJson(source[0]) !== canonicalJson(shard.source) ||
      canonicalJson(timezones) !== canonicalJson(shard.agencyTimezones) ||
      !context.manifest.shards.some(item => item.feedId === shard.feedId && canonicalJson(item.window) === canonicalJson(shard.window) && item.maxStopTimeSeconds === shard.maxStopTimeSeconds)) throw new Error('Realtime schedule identity mismatch');
  }
}

/** Date is never inferred from wall time. An ambiguous/missing frequency start is not a match. */
export function matchTripInstance(update: NormalizedTripUpdate, context: TripMatchContext): MatchedTripInstance | null {
  assertIdentity(context);
  return matchIndexedTrip(update, context, tripIndex(context));
}

/** Vehicles need the same date/frequency proof as departures; never infer a service date. */
export async function applyVehiclePositions(vehicles: NormalizedVehicle[], context: TripMatchContext): Promise<NormalizedVehicle[]> {
  assertIdentity(context);
  if (!sameStaticVersion(await staticVersion(context.manifest), context.version)) throw new Error('Realtime static artifact version mismatch');
  for (const shard of context.shards) {
    const bytes = encodeScheduleShard(shard), hash = await sha256(bytes);
    if (!context.manifest.shards.some(descriptor => descriptor.feedId === shard.feedId && descriptor.sha256 === hash && descriptor.byteLength === bytes.length)) throw new Error('Realtime schedule integrity failure');
  }
  const index = tripIndex(context);
  return vehicles.map(vehicle => {
    const match = matchIndexedTrip({ entityId: vehicle.entityId, tripId: vehicle.tripId, routeId: vehicle.routeId,
      startDate: vehicle.startDate, startTime: vehicle.startTime, scheduleRelationship: vehicle.scheduleRelationship ?? 'UNKNOWN', rawScheduleRelationship: 0, stops: [] }, context, index);
    const { tripInstanceRef: _unverified, ...base } = vehicle;
    return match ? { ...base, tripInstanceRef: match.tripInstanceRef, routeId: match.shard.routes.find(route => route.ref === match.trip.routeRef)!.providerId } : base;
  });
}

function tripIndex(context: TripMatchContext): Map<string, { shard: ScheduleShard; trip: ScheduleTrip }[]> {
  const index = new Map<string, { shard: ScheduleShard; trip: ScheduleTrip }[]>();
  for (const shard of context.shards) for (const trip of shard.trips) {
    const entries = index.get(trip.providerId) ?? []; entries.push({ shard, trip }); index.set(trip.providerId, entries);
  }
  return index;
}

function matchIndexedTrip(update: NormalizedTripUpdate, context: TripMatchContext, index: ReturnType<typeof tripIndex>): MatchedTripInstance | null {
  if (!update.tripId || !update.startDate || update.scheduleRelationship === 'UNKNOWN') return null;
  try { parseServiceDate(update.startDate); } catch { return null; }
  const candidates: MatchedTripInstance[] = [];
  for (const { shard, trip } of index.get(update.tripId) ?? []) {
    if (context.feedId && shard.feedId !== context.feedId) continue;
    if (update.startDate < shard.window.startDate || update.startDate > shard.window.endDate) continue;
    if (!isServiceActive(shard.calendars[trip.serviceId]!, update.startDate)) continue;
    const route = shard.routes.find(route => route.ref === trip.routeRef)!;
    if (update.routeId && route.providerId !== update.routeId) continue;
    const timezone = shard.agencyTimezones[route.agencyRef]!;
    const first = trip.stopTimes[0]?.departureSeconds;
    if (first == null) continue;
    const frequencies = shard.frequencies.filter(f => f.tripRef === trip.ref);
    let startSeconds = first;
    try { if (update.startTime) startSeconds = parseGtfsTime(update.startTime).totalSeconds; } catch { continue; }
    if (frequencies.length) {
      if (!update.startTime || !frequencies.some(f => startSeconds >= f.startSeconds && startSeconds < f.endSeconds &&
        (f.exactTimes === 0 ? update.scheduleRelationship === 'UNSCHEDULED' : (startSeconds - f.startSeconds) % f.headwaySeconds === 0))) continue;
    } else if (startSeconds !== first || update.scheduleRelationship === 'UNSCHEDULED') continue;
    const result: MatchedTripInstance = { shard, trip, timezone, serviceDate: update.startDate, startSeconds,
      shiftSeconds: startSeconds - first, originSeconds: serviceDayOrigin(update.startDate, timezone) / 1000,
      tripInstanceRef: formatTripInstanceRef({ coverage: shard.coverageId, feed: shard.feedId, id: trip.providerId, serviceDate: update.startDate, startTime: timeString(startSeconds) }) };
    if (!candidates.some(candidate => candidate.tripInstanceRef === result.tripInstanceRef)) candidates.push(result);
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function matchedUpdates(update: NormalizedTripUpdate, match: MatchedTripInstance): NormalizedStopUpdate[] | null {
  const { trip, shard } = match;
  let { startSeconds, originSeconds, serviceDate, tripInstanceRef, shiftSeconds } = match;
  let tripId = trip.providerId;
  if (update.scheduleRelationship === 'DUPLICATED') {
    const properties = update.tripProperties;
    if (!properties?.tripId || !properties.startDate || !properties.startTime) return null;
    try {
      parseServiceDate(properties.startDate);
      startSeconds = parseGtfsTime(properties.startTime).totalSeconds;
      originSeconds = serviceDayOrigin(properties.startDate, match.timezone) / 1000;
      shiftSeconds = startSeconds - trip.stopTimes[0]!.departureSeconds!;
      serviceDate = properties.startDate; tripId = properties.tripId;
      tripInstanceRef = formatTripInstanceRef({ coverage: shard.coverageId, feed: shard.feedId, id: tripId, serviceDate, startTime: timeString(startSeconds) });
    } catch { return null; }
  }
  const stops = new Map<number, DecodedStopUpdate>(); let previousSequence = -1;
  // Cancellation applies to the whole matched instance; attached stop updates have no semantics.
  for (const stop of update.scheduleRelationship === 'CANCELED' ? [] : update.stops) {
    const candidates = trip.stopTimes.filter(call => stop.stopSequence !== undefined ? call.sequence === stop.stopSequence : parseTransitRef(call.stopRef)?.id === stop.stopId);
    if (candidates.length !== 1 || stop.stopScheduleRelationship === 'UNKNOWN') return null;
    const call = candidates[0]!;
    if (stop.stopId && parseTransitRef(call.stopRef)?.id !== stop.stopId) return null;
    if (call.sequence <= previousSequence) return null;
    previousSequence = call.sequence; stops.set(call.sequence, stop);
  }
  let delay = update.delaySeconds;
  const result: NormalizedStopUpdate[] = [];
  for (const call of trip.stopTimes) {
    const stop = stops.get(call.sequence), scheduledArrival = call.arrivalSeconds == null ? undefined : originSeconds + call.arrivalSeconds + shiftSeconds;
    const scheduledDeparture = call.departureSeconds == null ? undefined : originSeconds + call.departureSeconds + shiftSeconds;
    const row: NormalizedStopUpdate = { entityId: update.entityId, tripId, routeId: parseTransitRef(trip.routeRef)!.id,
      stopId: parseTransitRef(call.stopRef)!.id, stopSequence: call.sequence, tripInstanceRef, serviceDate,
      scheduleRelationship: update.scheduleRelationship, stopScheduleRelationship: stop?.stopScheduleRelationship ?? 'SCHEDULED',
      scheduledArrivalTimeSeconds: scheduledArrival, scheduledDepartureTimeSeconds: scheduledDeparture, status: 'scheduled_only' };
    if (update.scheduleRelationship === 'CANCELED') { row.status = 'canceled'; result.push(row); continue; }
    if (stop?.stopScheduleRelationship === 'SKIPPED') { row.status = 'skipped'; result.push(row); continue; }
    if (stop?.stopScheduleRelationship === 'NO_DATA') { delay = undefined; result.push(row); continue; }
    const unscheduled = update.scheduleRelationship === 'UNSCHEDULED' || stop?.stopScheduleRelationship === 'UNSCHEDULED';
    const predict = (absolute: number | undefined, explicitDelay: number | undefined, scheduled: number | undefined) => {
      if (absolute !== undefined) { if (!unscheduled && scheduled !== undefined) delay = absolute - scheduled; return absolute; }
      if (unscheduled) return undefined;
      if (explicitDelay !== undefined) delay = explicitDelay;
      return delay !== undefined && scheduled !== undefined ? scheduled + delay : undefined;
    };
    row.arrivalTimeSeconds = predict(stop?.arrivalTimeSeconds, stop?.arrivalDelaySeconds, scheduledArrival);
    row.departureTimeSeconds = predict(stop?.departureTimeSeconds, stop?.departureDelaySeconds, scheduledDeparture);
    if (row.arrivalTimeSeconds !== undefined || row.departureTimeSeconds !== undefined) row.status = 'realtime';
    result.push(row);
  }
  return result;
}

function extraUpdates(update: NormalizedTripUpdate, context: TripMatchContext): NormalizedStopUpdate[] | null {
  if (!update.tripId || !update.startDate || !update.routeId || !update.stops.length) return null;
  try { parseServiceDate(update.startDate); } catch { return null; }
  const shard = context.shards.find(shard => (!context.feedId || shard.feedId === context.feedId) && shard.routes.some(route => route.providerId === update.routeId));
  if (!shard) return null;
  let sequence = -1;
  const result: NormalizedStopUpdate[] = [];
  for (const stop of update.stops) {
    if (!stop.stopId || stop.stopSequence === undefined || stop.stopSequence <= sequence || !shard.stops.some(s => s.providerId === stop.stopId) ||
      stop.arrivalTimeSeconds === undefined || stop.departureTimeSeconds === undefined || stop.stopScheduleRelationship === 'UNKNOWN') return null;
    sequence = stop.stopSequence;
    const noData = stop.stopScheduleRelationship === 'NO_DATA', skipped = stop.stopScheduleRelationship === 'SKIPPED';
    result.push({ ...stop, stopId: stop.stopId, tripId: update.tripId, routeId: update.routeId, serviceDate: update.startDate,
      scheduleRelationship: update.scheduleRelationship, status: skipped ? 'skipped' : noData ? 'scheduled_only' : 'realtime',
      ...(noData ? { scheduledArrivalTimeSeconds: stop.arrivalTimeSeconds, scheduledDepartureTimeSeconds: stop.departureTimeSeconds } : {}),
      ...(noData || skipped ? { arrivalTimeSeconds: undefined, departureTimeSeconds: undefined } : {}) });
  }
  return result;
}

/** Normalize only against shards already checked by loadScheduleWindow. Never fetches. */
export async function applyTripUpdates(feed: NormalizedRealtimeFeed, context: TripMatchContext): Promise<AppliedTripUpdates> {
  assertIdentity(context);
  if (!sameStaticVersion(await staticVersion(context.manifest), context.version)) throw new Error('Realtime static artifact version mismatch');
  for (const shard of context.shards) {
    const bytes = encodeScheduleShard(shard), hash = await sha256(bytes);
    if (!context.manifest.shards.some(descriptor => descriptor.feedId === shard.feedId && descriptor.sha256 === hash && descriptor.byteLength === bytes.length)) throw new Error('Realtime schedule integrity failure');
  }
  const staticIds = new Map<string, Set<string>>();
  for (const discovery of context.discoveries ?? []) {
    const bytes = new TextEncoder().encode(canonicalJson(discovery));
    decodeDiscoveryIndex(bytes);
    const descriptors = context.manifest.discoveries.filter(item => item.feedId === discovery.feedId);
    if (staticIds.has(discovery.feedId) || discovery.coverageId !== context.manifest.coverageId ||
      discovery.sourceSha256 !== context.version.sourceVersions[discovery.feedId] || descriptors.length !== 1 ||
      descriptors[0]!.byteLength !== bytes.length || descriptors[0]!.sha256 !== await sha256(bytes)) throw new Error('Realtime discovery integrity or identity failure');
    staticIds.set(discovery.feedId, new Set(discovery.tripProviderIds));
  }
  const stopUpdates: NormalizedStopUpdate[] = []; let eligible = 0, matched = 0, invalidExtras = false;
  const index = tripIndex(context);
  for (const update of feed.trips) {
    if (update.scheduleRelationship === 'ADDED' || update.scheduleRelationship === 'REPLACEMENT') {
      if (update.scheduleRelationship === 'REPLACEMENT') {
        const original = matchIndexedTrip(update, context, index);
        if (!original) { invalidExtras = true; continue; }
        const extras = extraUpdates({ ...update, routeId: update.routeId ?? parseTransitRef(original.trip.routeRef)!.id }, { ...context, shards: [original.shard] });
        if (!extras) { invalidExtras = true; continue; }
        for (const extra of extras) extra.tripInstanceRef = original.tripInstanceRef;
        const canceled = matchedUpdates({ ...update, scheduleRelationship: 'CANCELED', stops: [] }, original)!;
        stopUpdates.push(...extras, ...canceled.filter(call => !extras.some(extra => extra.stopId === call.stopId && extra.stopSequence === call.stopSequence)));
      } else {
        const extras = extraUpdates(update, context);
        if (!extras) { invalidExtras = true; continue; }
        stopUpdates.push(...extras);
      }
      continue;
    }
    eligible++;
    const match = matchIndexedTrip(update, context, index);
    if (match && update.scheduleRelationship === 'DUPLICATED') {
      const ids = staticIds.get(match.shard.feedId), duplicateId = update.tripProperties?.tripId;
      // Absence must be proven feed-wide, not inferred from the resident timetable window.
      if (!ids || !duplicateId || ids.has(duplicateId)) continue;
    }
    const updates = match ? matchedUpdates(update, match) : null;
    if (updates) { matched++; stopUpdates.push(...updates); }
  }
  const rate = eligible ? matched / eligible : 1;
  const degraded = invalidExtras || rate < SFBAY_COVERAGE.thresholds.minimumScheduleMatchRate;
  return { version: context.version, trips: feed.trips, stopUpdates, match: { eligible, matched, rate }, degraded,
    warnings: [...feed.warnings, ...(degraded ? ['SCHEDULE_REALTIME_MISMATCH'] : [])] };
}
