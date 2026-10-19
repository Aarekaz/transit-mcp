import { SFBAY_COVERAGE } from '../../../regions/sfbay';
import type { RealtimeSourcePolicy } from '../../../regions/types';
import { formatTripInstanceRef, parseTransitRef } from '../../core/refs';
import { isServiceActive, serviceDayOrigin, shiftServiceDate } from '../../planner/service-day';
import type { ArtifactManifestV2, DiscoveryIndex, ScheduleShard, ScheduleTrip } from '../static/schema';
import { canonicalJson, decodeDiscoveryIndex, encodeScheduleShard, sha256 } from '../static/shards';
import { parseGtfsTime, parseServiceDate } from '../static/time';
import type { DecodedStopUpdate, NormalizedRealtimeFeed, NormalizedStopUpdate, NormalizedTripUpdate, NormalizedVehicle } from './decode';
import { sameStaticVersion, staticVersion, type StaticVersion } from './snapshot-store';

export interface TripMatchContext {
  manifest: ArtifactManifestV2; shards: ScheduleShard[]; discoveries?: DiscoveryIndex[]; version: StaticVersion; feedId?: string;
  /** Provider identity rule; defaults to exact trip IDs. */
  tripMatching?: RealtimeSourcePolicy['tripMatching'];
  minimumScheduleMatchRate?: number;
}
/** The realtime trip_id a provider publishes for one static trip. */
export function realtimeTripKey(providerId: string, strategy: TripMatchContext['tripMatching'] = 'exact'): string {
  if (strategy !== 'nyct_suffix') return providerId;
  const separator = providerId.indexOf('_');
  return separator < 0 ? providerId : providerId.slice(separator + 1);
}
export interface MatchedTripInstance {
  shard: ScheduleShard; trip: ScheduleTrip; timezone: string; serviceDate: string;
  startSeconds: number; shiftSeconds: number; originSeconds: number; tripInstanceRef: string;
}
export interface AppliedTripUpdates {
  version: StaticVersion; trips: NormalizedTripUpdate[]; stopUpdates: NormalizedStopUpdate[];
  match: { eligible: number; matched: number; rate: number };
  /** Trips proven to serve no rider; never part of the match rate. */
  excluded: { nonRevenue: number; invalidExtras: number; unrepresentableAdded: number }; degraded: boolean; warnings: string[];
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
      !context.manifest.shards.some(item => item.feedId === shard.feedId && canonicalJson(item.window) === canonicalJson(shard.window) && item.maxStopTimeSeconds === shard.maxStopTimeSeconds &&
        canonicalJson(item.timeRange ?? null) === canonicalJson(shard.timeRange ?? null))) throw new Error('Realtime schedule identity mismatch');
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
    const key = realtimeTripKey(trip.providerId, context.tripMatching);
    const entries = index.get(key) ?? []; entries.push({ shard, trip }); index.set(key, entries);
  }
  return index;
}

function matchIndexedTrip(update: NormalizedTripUpdate, context: TripMatchContext, index: ReturnType<typeof tripIndex>): MatchedTripInstance | null {
  if (!update.tripId || !update.startDate || update.scheduleRelationship === 'UNKNOWN') return null;
  try { parseServiceDate(update.startDate); } catch { return null; }
  const exact = tripCandidates(update, update.tripId, update.startDate, context, index);
  if (exact.length || context.tripMatching !== 'nyct_suffix') return exact.length === 1 ? exact[0]! : null;
  // NYCT dates a trip running after midnight by calendar day, either keeping its >24h
  // origin (144000_6..N04X001) or restarting the clock (003750_J..N41R for 147750). Both
  // name the previous service day's trip; used only when the start date has no match.
  const previous = nyctPreviousDayTripId(update.tripId);
  if (!previous) return null;
  const shifted = tripCandidates(update, previous, shiftServiceDate(update.startDate, -1), context, index);
  return shifted.length === 1 ? shifted[0]! : null;
}

/** NYCT trip IDs start with the origin time in hundredths of a minute (144000 = 24:00). */
export function nyctPreviousDayTripId(tripId: string): string | null {
  const match = /^(\d{6})(_.+)$/.exec(tripId);
  if (!match) return null;
  const origin = Number(match[1]);
  return origin >= 144_000 ? tripId : `${String(origin + 144_000).padStart(6, '0')}${match[2]}`;
}

function tripCandidates(update: NormalizedTripUpdate, tripKey: string, serviceDate: string, context: TripMatchContext, index: ReturnType<typeof tripIndex>): MatchedTripInstance[] {
  const candidates: MatchedTripInstance[] = [];
  for (const { shard, trip } of index.get(tripKey) ?? []) {
    if (context.feedId && shard.feedId !== context.feedId) continue;
    if (serviceDate < shard.window.startDate || serviceDate > shard.window.endDate) continue;
    if (!isServiceActive(shard.calendars[trip.serviceId]!, serviceDate)) continue;
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
    } else if (update.scheduleRelationship === 'UNSCHEDULED') continue;
    // NYCT start_time reports the actual dispatch, not the scheduled origin time; its
    // trip_id already encodes the scheduled origin, so identity is (trip, date, route).
    else if (context.tripMatching === 'nyct_suffix') startSeconds = first;
    else if (startSeconds !== first) continue;
    const result: MatchedTripInstance = { shard, trip, timezone, serviceDate, startSeconds,
      shiftSeconds: startSeconds - first, originSeconds: serviceDayOrigin(serviceDate, timezone) / 1000,
      tripInstanceRef: formatTripInstanceRef({ coverage: shard.coverageId, feed: shard.feedId, id: trip.providerId, serviceDate, startTime: timeString(startSeconds) }) };
    if (!candidates.some(candidate => candidate.tripInstanceRef === result.tripInstanceRef)) candidates.push(result);
  }
  return candidates;
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

/** NYCT reports the complete list of a train's remaining calls. A scheduled call absent
 * from that list cannot be boarded (already served, or rerouted away), so it is marked
 * skipped; reported stops outside the pattern are observed, unscheduled calls. */
function nyctMatchedUpdates(update: NormalizedTripUpdate, match: MatchedTripInstance, stopIds: Set<string>): NormalizedStopUpdate[] | null {
  const { trip, originSeconds, shiftSeconds, serviceDate, tripInstanceRef } = match;
  if (update.scheduleRelationship === 'CANCELED') return matchedUpdates(update, match);
  if (update.scheduleRelationship !== 'SCHEDULED') return null;
  const routeId = parseTransitRef(trip.routeRef)!.id, rows: NormalizedStopUpdate[] = [], served = new Map<number, DecodedStopUpdate>();
  const destinationStopId = update.stops.at(-1)?.stopId;
  let cursor = -1;
  for (const stop of update.stops) {
    if (!stop.stopId || !stopIds.has(stop.stopId) || stop.stopScheduleRelationship === 'UNKNOWN') return null;
    const predicted = { arrivalTimeSeconds: stop.arrivalTimeSeconds, departureTimeSeconds: stop.departureTimeSeconds };
    if (predicted.arrivalTimeSeconds === undefined && predicted.departureTimeSeconds === undefined) return null;
    const call = trip.stopTimes.find(call => call.sequence > cursor && parseTransitRef(call.stopRef)?.id === stop.stopId);
    if (call) { cursor = call.sequence; served.set(call.sequence, stop); continue; }
    rows.push({ entityId: update.entityId, tripId: trip.providerId, routeId, stopId: stop.stopId, tripInstanceRef, serviceDate,
      scheduleRelationship: 'SCHEDULED', stopScheduleRelationship: stop.stopScheduleRelationship ?? 'SCHEDULED', ...predicted,
      status: stop.stopScheduleRelationship === 'SKIPPED' ? 'skipped' : 'realtime', scheduleMatch: 'unscheduled_call', destinationStopId });
  }
  for (const call of trip.stopTimes) {
    const stop = served.get(call.sequence);
    const scheduled = (seconds: number | null) => seconds === null ? undefined : originSeconds + seconds + shiftSeconds;
    rows.push({ entityId: update.entityId, tripId: trip.providerId, routeId, stopId: parseTransitRef(call.stopRef)!.id, stopSequence: call.sequence,
      tripInstanceRef, serviceDate, scheduleRelationship: 'SCHEDULED', stopScheduleRelationship: stop?.stopScheduleRelationship ?? 'SKIPPED',
      scheduledArrivalTimeSeconds: scheduled(call.arrivalSeconds), scheduledDepartureTimeSeconds: scheduled(call.departureSeconds),
      arrivalTimeSeconds: stop?.arrivalTimeSeconds, departureTimeSeconds: stop?.departureTimeSeconds,
      status: !stop || stop.stopScheduleRelationship === 'SKIPPED' ? 'skipped' : 'realtime', scheduleMatch: 'matched' });
  }
  return rows;
}

/** An observed NYCT train without a canonical schedule is still service at real stops. */
function nyctObservedUpdates(update: NormalizedTripUpdate, context: TripMatchContext, stopIds: Set<string>, routeIds: Set<string>): NormalizedStopUpdate[] | null {
  if (update.scheduleRelationship !== 'SCHEDULED' || !update.tripId || !update.startDate || !update.startTime || !update.routeId || !routeIds.has(update.routeId)) return null;
  let tripInstanceRef: string;
  try {
    parseServiceDate(update.startDate);
    tripInstanceRef = formatTripInstanceRef({ coverage: context.manifest.coverageId, feed: context.feedId!, id: update.tripId,
      serviceDate: update.startDate, startTime: timeString(parseGtfsTime(update.startTime).totalSeconds) });
  } catch { return null; }
  const destinationStopId = update.stops.at(-1)?.stopId;
  const rows: NormalizedStopUpdate[] = [];
  for (const stop of update.stops) {
    if (!stop.stopId || !stopIds.has(stop.stopId) || stop.stopScheduleRelationship === 'UNKNOWN' ||
      stop.arrivalTimeSeconds === undefined && stop.departureTimeSeconds === undefined) return null;
    rows.push({ entityId: update.entityId, tripId: update.tripId, routeId: update.routeId, stopId: stop.stopId, tripInstanceRef, serviceDate: update.startDate,
      scheduleRelationship: 'SCHEDULED', stopScheduleRelationship: stop.stopScheduleRelationship ?? 'SCHEDULED',
      arrivalTimeSeconds: stop.arrivalTimeSeconds, departureTimeSeconds: stop.departureTimeSeconds,
      status: stop.stopScheduleRelationship === 'SKIPPED' ? 'skipped' : 'realtime', scheduleMatch: 'unmatched_trip', destinationStopId });
  }
  return rows;
}

/** ADDED service has no canonical schedule: keep it as an observed train at real stops.
 * Its instance identity is the provider trip, service date and start time (the reported
 * start_time, else its first observed call); never a scheduled time. */
function addedUpdates(update: NormalizedTripUpdate, context: TripMatchContext): NormalizedStopUpdate[] | null {
  if (!update.tripId || !update.startDate || !update.routeId || !update.stops.length) return null;
  try { parseServiceDate(update.startDate); } catch { return null; }
  const shard = context.shards.find(shard => (!context.feedId || shard.feedId === context.feedId) && shard.routes.some(route => route.providerId === update.routeId));
  if (!shard) return null;
  const route = shard.routes.find(route => route.providerId === update.routeId)!, timezone = shard.agencyTimezones[route.agencyRef];
  const stopIds = new Set(shard.stops.map(stop => stop.providerId));
  let sequence = -1;
  for (const stop of update.stops) {
    if (!stop.stopId || !stopIds.has(stop.stopId) || stop.stopScheduleRelationship === 'UNKNOWN') return null;
    if (stop.stopSequence !== undefined) { if (stop.stopSequence <= sequence) return null; sequence = stop.stopSequence; }
    const timed = stop.stopScheduleRelationship === 'SKIPPED' || stop.stopScheduleRelationship === 'NO_DATA' || stop.arrivalTimeSeconds !== undefined || stop.departureTimeSeconds !== undefined;
    if (!timed) return null;
  }
  let startSeconds: number;
  try {
    if (update.startTime) startSeconds = parseGtfsTime(update.startTime).totalSeconds;
    else {
      const first = update.stops.map(stop => stop.departureTimeSeconds ?? stop.arrivalTimeSeconds).find(value => value !== undefined);
      if (first === undefined || !timezone) return null;
      startSeconds = first - serviceDayOrigin(update.startDate, timezone) / 1000;
      if (!Number.isInteger(startSeconds) || startSeconds < 0 || startSeconds > 48 * 3600) return null;
    }
  } catch { return null; }
  const tripInstanceRef = formatTripInstanceRef({ coverage: shard.coverageId, feed: shard.feedId, id: update.tripId, serviceDate: update.startDate, startTime: timeString(startSeconds) });
  const destinationStopId = update.stops.at(-1)?.stopId;
  return update.stops.filter(stop => stop.stopScheduleRelationship !== 'NO_DATA').map(stop => ({ ...stop, stopId: stop.stopId!, tripId: update.tripId, routeId: update.routeId,
    serviceDate: update.startDate, scheduleRelationship: 'ADDED' as const, tripInstanceRef, destinationStopId, scheduleMatch: 'unmatched_trip' as const,
    status: stop.stopScheduleRelationship === 'SKIPPED' ? 'skipped' as const : 'realtime' as const,
    ...(stop.stopScheduleRelationship === 'SKIPPED' ? { arrivalTimeSeconds: undefined, departureTimeSeconds: undefined } : {}) }));
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
  const stopUpdates: NormalizedStopUpdate[] = []; let eligible = 0, matched = 0, invalidExtras = 0, nonRevenue = 0, unrepresentableAdded = 0;
  const index = tripIndex(context);
  const shardsInFeed = context.shards.filter(shard => !context.feedId || shard.feedId === context.feedId);
  const routeIds = new Set(shardsInFeed.flatMap(shard => shard.routes.map(route => route.providerId)));
  const stopIds = new Set(shardsInFeed.flatMap(shard => shard.stops.map(stop => stop.providerId)));
  const nyct = context.tripMatching === 'nyct_suffix';
  for (const update of feed.trips) {
    // A move on a route the schedule does not publish, skipping every stop it lists,
    // serves no rider (e.g. WMATA non-revenue "NR" moves); it is not a match failure.
    if (update.routeId && !routeIds.has(update.routeId) && update.stops.every(stop => stop.stopScheduleRelationship === 'SKIPPED')) { nonRevenue++; continue; }
    if (update.scheduleRelationship === 'ADDED' || update.scheduleRelationship === 'REPLACEMENT') {
      if (update.scheduleRelationship === 'REPLACEMENT') {
        const original = matchIndexedTrip(update, context, index);
        if (!original) { invalidExtras++; continue; }
        const extras = extraUpdates({ ...update, routeId: update.routeId ?? parseTransitRef(original.trip.routeRef)!.id }, { ...context, shards: [original.shard] });
        if (!extras) { invalidExtras++; continue; }
        for (const extra of extras) extra.tripInstanceRef = original.tripInstanceRef;
        const canceled = matchedUpdates({ ...update, scheduleRelationship: 'CANCELED', stops: [] }, original)!;
        stopUpdates.push(...extras, ...canceled.filter(call => !extras.some(extra => extra.stopId === call.stopId && extra.stopSequence === call.stopSequence)));
      } else {
        // An unrepresentable added train is counted and excluded; it never blanks
        // every other prediction.
        const added = addedUpdates(update, context);
        if (!added) { unrepresentableAdded++; continue; }
        stopUpdates.push(...added);
      }
      continue;
    }
    eligible++;
    const match = matchIndexedTrip(update, context, index);
    if (nyct) {
      const rows = match ? nyctMatchedUpdates(update, match, stopIds) : nyctObservedUpdates(update, context, stopIds, routeIds);
      if (match && rows) matched++;
      if (rows) stopUpdates.push(...rows);
      continue;
    }
    if (match && update.scheduleRelationship === 'DUPLICATED') {
      const ids = staticIds.get(match.shard.feedId), duplicateId = update.tripProperties?.tripId;
      // Absence must be proven feed-wide, not inferred from the resident timetable window.
      if (!ids || !duplicateId || ids.has(duplicateId)) continue;
    }
    const updates = match ? matchedUpdates(update, match) : null;
    if (updates) { matched++; stopUpdates.push(...updates); }
  }
  const rate = eligible ? matched / eligible : 1;
  const degraded = invalidExtras > 0 || rate < (context.minimumScheduleMatchRate ?? SFBAY_COVERAGE.thresholds.minimumScheduleMatchRate);
  return { version: context.version, trips: feed.trips, stopUpdates, match: { eligible, matched, rate }, excluded: { nonRevenue, invalidExtras, unrepresentableAdded }, degraded,
    warnings: [...feed.warnings, ...(degraded ? ['SCHEDULE_REALTIME_MISMATCH'] : [])] };
}
