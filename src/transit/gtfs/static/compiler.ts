import { parseGtfsCsv, type GtfsCsvRow } from './csv';
import { createStaticArtifact, type ArtifactRoute, type ArtifactStop, type StaticTransitArtifact } from './artifact';
import { routeTypeToMode } from './modes';
import { parseGtfsTime, parseServiceDate } from './time';
import type { ServiceCalendar } from './artifact';
import { formatEntityRef, type TransitEntityKind, type TransitRef } from '../../core/refs';
import { canonicalJson, encodeScheduleShard, sha256 } from './shards';
import type { CompileScheduleInput, CompiledSchedule, SchedulePattern, ScheduleShard, ScheduleTrip, ServiceWindow } from './schema';

export type GtfsStaticFiles = Record<'stops.txt' | 'routes.txt' | 'trips.txt' | 'stop_times.txt', string> & Partial<Record<'calendar.txt' | 'calendar_dates.txt', string>>;

function required(row: GtfsCsvRow, name: string): string {
  const value = row[name];
  if (!value) throw new Error(`Missing required GTFS field: ${name}`);
  return value;
}

function integer(row: GtfsCsvRow, field: string, fallback?: number, maximum = 0xfffffffe): number {
  if (!row[field] && fallback !== undefined) return fallback;
  const value = finiteNumber(row, field);
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`Invalid GTFS integer: ${field}`);
  return value;
}

function indexed(rows: GtfsCsvRow[], field: string): Map<string, GtfsCsvRow> {
  const result = new Map<string, GtfsCsvRow>();
  for (const row of rows) {
    const id = required(row, field);
    if (result.has(id)) throw new Error(`duplicate ${field}`);
    result.set(id, row);
  }
  return result;
}

function activeInWindow(calendar: ServiceCalendar, window: ServiceWindow): boolean {
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
  const end = parseServiceDate(window.endDate).getTime();
  for (let date = parseServiceDate(window.startDate); date.getTime() <= end; date = new Date(date.getTime() + 86_400_000)) {
    const key = date.toISOString().slice(0, 10).replaceAll('-', '');
    if (calendar.exceptions[key] === 1) return true;
    if (calendar.exceptions[key] !== 2 && key >= calendar.startDate && key <= calendar.endDate && calendar[weekdays[date.getUTCDay()]!]) return true;
  }
  return false;
}

/** Offline, coverage-neutral compiler. It never accesses upstream or runtime bindings. */
export async function compileSchedule(input: CompileScheduleInput): Promise<CompiledSchedule> {
  const { coverage, feedId, files, window } = input;
  if (!coverage.feeds.some(feed => feed.id === feedId)) throw new Error('Unknown coverage feed');
  const start = parseServiceDate(window.startDate), end = parseServiceDate(window.endDate);
  if (start > end || end.getTime() - start.getTime() > 366 * 86_400_000) throw new Error('Invalid service date window (maximum 367 days)');
  const url = new URL(input.source.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid public source URL');
  if (!Number.isFinite(Date.parse(input.source.retrievedAt))) throw new Error('Invalid source retrieval timestamp');
  const ref = (kind: TransitEntityKind, id: string) => formatEntityRef({ coverage: coverage.id, feed: feedId, kind, id });
  const tables = Object.fromEntries(Object.entries(files).map(([name, csv]) => [name, parseGtfsCsv(csv).sort((a, b) => {
    const left = canonicalJson(a), right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  })]));
  const rows = (name: string) => tables[name] ?? [];
  const agencyRows = rows('agency.txt');
  // GTFS permits the ID to be absent only for a single agency. Keep the raw
  // tables unchanged for source hashing, and expose normalization as provenance.
  const anonymousAgencyId = agencyRows.length === 1 && !agencyRows[0]!.agency_id ? '__anonymous_agency__' : undefined;
  const agencies = indexed(anonymousAgencyId ? [{ ...agencyRows[0]!, agency_id: anonymousAgencyId }] : agencyRows, 'agency_id');
  if (!agencies.size) throw new Error('Missing agency.txt');
  const agencyTimezones: Record<TransitRef, string> = {};
  for (const [id, agency] of agencies) {
    const timezone = required(agency, 'agency_timezone');
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0); }
    catch { throw new Error('Invalid agency timezone'); }
    agencyTimezones[ref('agency', id)] = timezone;
  }
  const stopRows = indexed(rows('stops.txt'), 'stop_id');
  const routeRows = indexed(rows('routes.txt'), 'route_id');
  const tripRows = indexed(rows('trips.txt'), 'trip_id');
  const reference = (kind: 'stop' | 'route' | 'trip' | 'agency', id: string): TransitRef => {
    const map = { stop: stopRows, route: routeRows, trip: tripRows, agency: agencies }[kind];
    if (!map.has(id)) throw new Error(`unknown ${kind} reference`);
    return ref(kind, id);
  };
  const optionalNumber = (row: GtfsCsvRow, field: string) => row[field] ? finiteNumber(row, field) : null;
  const stops = [...stopRows].map(([id, row]) => ({
    ref: ref('stop', id), providerId: id, name: row.stop_name ?? '',
    latitude: optionalNumber(row, 'stop_lat'), longitude: optionalNumber(row, 'stop_lon'),
    locationType: integer(row, 'location_type', 0, 4), wheelchairBoarding: integer(row, 'wheelchair_boarding', 0, 2),
    ...(row.parent_station ? { parentStationRef: (() => {
      if (!stopRows.has(row.parent_station)) throw new Error('unknown parent reference');
      return ref('stop', row.parent_station);
    })() } : {}),
  })).sort((a, b) => a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0);
  const routes = [...routeRows].map(([id, row]) => {
    const agencyId = row.agency_id || (agencies.size === 1 ? agencies.keys().next().value! : required(row, 'agency_id'));
    const routeType = integer(row, 'route_type');
    return { ref: ref('route', id), providerId: id, agencyRef: reference('agency', agencyId),
      shortName: row.route_short_name ?? '', longName: row.route_long_name ?? '', routeType,
      mode: routeTypeToMode(routeType), color: row.route_color ?? '', textColor: row.route_text_color ?? '' };
  }).sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  const calendars: Record<string, ServiceCalendar> = Object.create(null);
  for (const [id, row] of indexed(rows('calendar.txt'), 'service_id')) {
    const startDate = required(row, 'start_date'), endDate = required(row, 'end_date');
    if (parseServiceDate(startDate) > parseServiceDate(endDate)) throw new Error('Invalid calendar date range');
    calendars[id] = { monday: integer(row, 'monday', undefined, 1) === 1, tuesday: integer(row, 'tuesday', undefined, 1) === 1,
      wednesday: integer(row, 'wednesday', undefined, 1) === 1, thursday: integer(row, 'thursday', undefined, 1) === 1,
      friday: integer(row, 'friday', undefined, 1) === 1, saturday: integer(row, 'saturday', undefined, 1) === 1,
      sunday: integer(row, 'sunday', undefined, 1) === 1, startDate, endDate, exceptions: {} };
  }
  for (const row of rows('calendar_dates.txt')) {
    const id = required(row, 'service_id'), date = required(row, 'date');
    parseServiceDate(date);
    const type = integer(row, 'exception_type', undefined, 2);
    if (type !== 1 && type !== 2) throw new Error('Invalid exception_type');
    const calendar = calendars[id] ??= { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false, startDate: '00000000', endDate: '99999999', exceptions: {} };
    if (calendar.exceptions[date]) throw new Error('duplicate calendar exception');
    calendar.exceptions[date] = type;
  }
  const trips: ScheduleTrip[] = [...tripRows].map(([id, row]) => {
    const serviceId = required(row, 'service_id');
    if (!calendars[serviceId]) throw new Error('unknown service reference');
    return { ref: ref('trip', id), providerId: id, routeRef: reference('route', required(row, 'route_id')), serviceId,
      patternId: '', headsign: row.trip_headsign ?? '', directionId: row.direction_id ? integer(row, 'direction_id', undefined, 1) : null,
      blockId: row.block_id ?? '', wheelchairAccessible: integer(row, 'wheelchair_accessible', 0, 2), bikesAllowed: integer(row, 'bikes_allowed', 0, 2), stopTimes: [] };
  }).sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  const tripsByRef = new Map(trips.map(trip => [trip.ref, trip]));
  const stopRoutes: Record<TransitRef, TransitRef[]> = {};
  for (const row of rows('stop_times.txt')) {
    const trip = tripsByRef.get(reference('trip', required(row, 'trip_id')))!;
    const stopRef = reference('stop', required(row, 'stop_id'));
    if (Boolean(row.arrival_time) !== Boolean(row.departure_time)) throw new Error('Incomplete stop time');
    const arrivalSeconds = row.arrival_time ? parseGtfsTime(row.arrival_time).totalSeconds : null;
    const departureSeconds = row.departure_time ? parseGtfsTime(row.departure_time).totalSeconds : null;
    trip.stopTimes.push({ stopRef, sequence: integer(row, 'stop_sequence'), arrivalSeconds, departureSeconds,
      pickupType: integer(row, 'pickup_type', 0, 3), dropOffType: integer(row, 'drop_off_type', 0, 3),
      timepoint: integer(row, 'timepoint', 1, 1), headsign: row.stop_headsign ?? '' });
    (stopRoutes[stopRef] ??= []).push(trip.routeRef);
    const parent = stopRows.get(required(row, 'stop_id'))!.parent_station;
    if (parent) (stopRoutes[ref('stop', parent)] ??= []).push(trip.routeRef);
  }
  const patterns = new Map<string, SchedulePattern>();
  const patternHashes = new Map<string, string>();
  for (const trip of trips) {
    trip.stopTimes.sort((a, b) => a.sequence - b.sequence);
    if (!trip.stopTimes.length) throw new Error('Trip has no stop times');
    let previousSequence = -1, previousDeparture = -1;
    for (const time of trip.stopTimes) {
      if (time.sequence === previousSequence) throw new Error('duplicate stop_sequence');
      previousSequence = time.sequence;
      if (time.arrivalSeconds !== null && time.departureSeconds !== null) {
        if (time.arrivalSeconds < previousDeparture || time.departureSeconds < time.arrivalSeconds) throw new Error('nonmonotonic trip times');
        previousDeparture = time.departureSeconds;
      }
    }
    const pattern = { routeRef: trip.routeRef, directionId: trip.directionId, stopRefs: trip.stopTimes.map(t => t.stopRef), pickupTypes: trip.stopTimes.map(t => t.pickupType), dropOffTypes: trip.stopTimes.map(t => t.dropOffType) };
    const patternJson = canonicalJson(pattern);
    trip.patternId = patternHashes.get(patternJson) ?? await sha256(new TextEncoder().encode(patternJson));
    patternHashes.set(patternJson, trip.patternId);
    patterns.set(trip.patternId, { id: trip.patternId, ...pattern });
  }
  const frequencies = rows('frequencies.txt').map(row => {
    const startSeconds = parseGtfsTime(required(row, 'start_time')).totalSeconds;
    const endSeconds = parseGtfsTime(required(row, 'end_time')).totalSeconds;
    const headwaySeconds = integer(row, 'headway_secs');
    if (endSeconds <= startSeconds || headwaySeconds === 0) throw new Error('Invalid frequency interval');
    return { tripRef: reference('trip', required(row, 'trip_id')), startSeconds, endSeconds, headwaySeconds, exactTimes: integer(row, 'exact_times', 0, 1) };
  });
  const transfers = rows('transfers.txt').map(row => {
    const transferType = integer(row, 'transfer_type', 0, 5);
    if (transferType < 4 && (!row.from_stop_id || !row.to_stop_id)) throw new Error('Missing transfer endpoints');
    if (transferType >= 4 && (!row.from_trip_id || !row.to_trip_id)) throw new Error('Missing in-seat transfer endpoints');
    if (transferType === 2 && !row.min_transfer_time) throw new Error('Missing min_transfer_time');
    return {
      ...(row.from_stop_id ? { fromStopRef: reference('stop', row.from_stop_id) } : {}),
      ...(row.to_stop_id ? { toStopRef: reference('stop', row.to_stop_id) } : {}),
      ...(row.from_route_id ? { fromRouteRef: reference('route', row.from_route_id) } : {}),
      ...(row.to_route_id ? { toRouteRef: reference('route', row.to_route_id) } : {}),
      ...(row.from_trip_id ? { fromTripRef: reference('trip', row.from_trip_id) } : {}),
      ...(row.to_trip_id ? { toTripRef: reference('trip', row.to_trip_id) } : {}),
      transferType, minTransferSeconds: row.min_transfer_time ? integer(row, 'min_transfer_time') : null,
    };
  });
  const pathways = [...indexed(rows('pathways.txt'), 'pathway_id')].map(([id, row]) => ({
    id, fromStopRef: reference('stop', required(row, 'from_stop_id')), toStopRef: reference('stop', required(row, 'to_stop_id')),
    mode: integer(row, 'pathway_mode', undefined, 7), bidirectional: integer(row, 'is_bidirectional', undefined, 1) === 1,
    lengthMetres: optionalNumber(row, 'length'), traversalSeconds: row.traversal_time ? integer(row, 'traversal_time') : null,
    stairCount: optionalNumber(row, 'stair_count'), maxSlope: optionalNumber(row, 'max_slope'), minWidthMetres: optionalNumber(row, 'min_width'),
    signpostedAs: row.signposted_as ?? '', reversedSignpostedAs: row.reversed_signposted_as ?? '',
  }));
  const source = { feedId, url: url.href, retrievedAt: input.source.retrievedAt,
    sha256: await sha256(new TextEncoder().encode(canonicalJson(tables))), feedInfo: rows('feed_info.txt'),
    ...(anonymousAgencyId ? { anonymousAgencyRef: ref('agency', anonymousAgencyId) } : {}) };
  for (const info of source.feedInfo) {
    for (const field of ['feed_publisher_url', 'feed_contact_url']) {
      if (!info[field]) continue;
      const link = new URL(info[field]);
      if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password || link.search || link.hash) throw new Error('Invalid public feed_info URL');
    }
    if (info.feed_start_date) parseServiceDate(info.feed_start_date);
    if (info.feed_end_date) parseServiceDate(info.feed_end_date);
  }
  const activeServices = new Set(Object.entries(calendars).filter(([, calendar]) => activeInWindow(calendar, window)).map(([id]) => id));
  const activeTrips = trips.filter(trip => activeServices.has(trip.serviceId));
  const activeRefs = new Set(activeTrips.map(trip => trip.ref));
  const activePatterns = new Set(activeTrips.map(trip => trip.patternId));
  const blocks: Record<string, TransitRef[]> = Object.create(null);
  for (const trip of activeTrips) if (trip.blockId) (blocks[trip.blockId] ??= []).push(trip.ref);
  const transferTripRefs = new Set(transfers.flatMap(transfer => [transfer.fromTripRef, transfer.toTripRef].filter((value): value is TransitRef => value !== undefined)));
  const transferBoundaryTrips = trips.filter(trip => transferTripRefs.has(trip.ref) && !activeRefs.has(trip.ref)).map(trip => ({
    ref: trip.ref, providerId: trip.providerId, routeRef: trip.routeRef, serviceId: trip.serviceId,
    firstDepartureSeconds: trip.stopTimes[0]!.departureSeconds, lastArrivalSeconds: trip.stopTimes.at(-1)!.arrivalSeconds,
  }));
  let maxStopTimeSeconds = 0;
  for (const trip of trips) for (const time of trip.stopTimes) maxStopTimeSeconds = Math.max(maxStopTimeSeconds, time.departureSeconds ?? 0);
  for (const frequency of frequencies) {
    const trip = tripsByRef.get(frequency.tripRef)!;
    const first = trip.stopTimes[0]!.departureSeconds;
    const last = trip.stopTimes.at(-1)!.departureSeconds;
    if (first !== null && last !== null) maxStopTimeSeconds = Math.max(maxStopTimeSeconds, frequency.endSeconds - 1 + last - first);
  }
  const shard: ScheduleShard = { schemaVersion: 2, coverageId: coverage.id, feedId, window: { ...window }, maxStopTimeSeconds, source, agencyTimezones,
    stops, routes, trips: activeTrips, patterns: [...patterns.values()].filter(p => activePatterns.has(p.id)).sort((a, b) => a.id < b.id ? -1 : 1),
    calendars, frequencies: frequencies.filter(f => activeRefs.has(f.tripRef)), blocks,
    transfers, transferBoundaryTrips, pathways };
  const discovery = { schemaVersion: 2 as const, coverageId: coverage.id, feedId, stops: stops.filter(s => s.locationType !== 3), routes,
    stopRoutes: Object.fromEntries(Object.entries(stopRoutes).map(([key, values]) => [key, [...new Set(values)].sort()])) };
  const shardBytes = encodeScheduleShard(shard);
  const discoveryBytes = new TextEncoder().encode(canonicalJson(discovery));
  const shardHash = await sha256(shardBytes), discoveryHash = await sha256(discoveryBytes);
  const prefix = `artifacts/${coverage.id}/v2/${feedId}`;
  return { shard, discovery, shardBytes, discoveryBytes, manifest: {
    schemaVersion: 2, coverageId: coverage.id, sources: [source], agencyTimezones,
    discovery: { key: `${prefix}/discovery/${discoveryHash}.json`, sha256: discoveryHash, byteLength: discoveryBytes.length },
    shards: [{ feedId, window: { ...window }, maxStopTimeSeconds, key: `${prefix}/${window.startDate}-${window.endDate}/${shardHash}.bin`, sha256: shardHash, byteLength: shardBytes.length }],
  } };
}

function finiteNumber(row: GtfsCsvRow, name: string): number {
  const value = Number(required(row, name));
  if (!Number.isFinite(value)) throw new Error(`Invalid GTFS number: ${name}`);
  return value;
}

export function compileGtfsStatic(
  files: GtfsStaticFiles,
  metadata: { sourceVersion: string; generatedAt: string },
  options: { includeSchedule?: boolean } = {},
): StaticTransitArtifact {
  const stopRows = parseGtfsCsv(files['stops.txt']);
  const routeRows = parseGtfsCsv(files['routes.txt']);
  const tripRows = parseGtfsCsv(files['trips.txt']);
  const stopTimeRows = parseGtfsCsv(files['stop_times.txt']);

  const stops: ArtifactStop[] = stopRows
    .filter(row => row.location_type !== '3')
    .map(row => ({
    id: required(row, 'stop_id'),
    name: required(row, 'stop_name'),
    latitude: finiteNumber(row, 'stop_lat'),
    longitude: finiteNumber(row, 'stop_lon'),
    locationType: row.location_type ? finiteNumber(row, 'location_type') : 0,
    ...(row.parent_station ? { parentStationId: row.parent_station } : {}),
    }));
  const routes: ArtifactRoute[] = routeRows.map(row => ({
    id: required(row, 'route_id'),
    shortName: row.route_short_name ?? '',
    longName: row.route_long_name ?? '',
    mode: routeTypeToMode(finiteNumber(row, 'route_type')),
    ...(row.route_color ? { color: row.route_color } : {}),
  }));
  const trips = new Map(tripRows.map(row => [required(row, 'trip_id'), { routeId: required(row, 'route_id'), serviceId: required(row, 'service_id') }]));
  const parentByStop = new Map(stops.map(stop => [stop.id, stop.parentStationId]));
  const stopRoutes: Record<string, string[]> = {};

  for (const row of stopTimeRows) {
    const trip = trips.get(required(row, 'trip_id'));
    if (!trip) throw new Error('stop_times.txt references an unknown trip_id');
    const stopId = required(row, 'stop_id');
    (stopRoutes[stopId] ??= []).push(trip.routeId);
    const parentId = parentByStop.get(stopId);
    if (parentId) (stopRoutes[parentId] ??= []).push(trip.routeId);
  }

  const calendars: Record<string, ServiceCalendar> = {};
  for (const row of files['calendar.txt'] ? parseGtfsCsv(files['calendar.txt']) : []) {
    const serviceId = required(row, 'service_id');
    calendars[serviceId] = {
      monday: row.monday === '1', tuesday: row.tuesday === '1', wednesday: row.wednesday === '1', thursday: row.thursday === '1',
      friday: row.friday === '1', saturday: row.saturday === '1', sunday: row.sunday === '1',
      startDate: required(row, 'start_date'), endDate: required(row, 'end_date'), exceptions: {},
    };
  }
  for (const row of files['calendar_dates.txt'] ? parseGtfsCsv(files['calendar_dates.txt']) : []) {
    const serviceId = required(row, 'service_id');
    const calendar = calendars[serviceId] ??= { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false, startDate: '00000000', endDate: '99999999', exceptions: {} };
    calendar.exceptions[required(row, 'date')] = finiteNumber(row, 'exception_type') as 1 | 2;
  }
  const stopTimes = stopTimeRows
    .filter(row => row.arrival_time && row.departure_time)
    .map(row => {
    const tripId = required(row, 'trip_id');
    const trip = trips.get(tripId)!;
    return { tripId, routeId: trip.routeId, serviceId: trip.serviceId, stopId: required(row, 'stop_id'), arrivalSeconds: parseGtfsTime(required(row, 'arrival_time')).totalSeconds, departureSeconds: parseGtfsTime(required(row, 'departure_time')).totalSeconds };
    });

  return createStaticArtifact({
    region: 'sfbay',
    sourceVersion: metadata.sourceVersion,
    generatedAt: metadata.generatedAt,
    stops,
    routes,
    stopRoutes,
    ...(options.includeSchedule === false ? {} : { stopTimes, calendars }),
  });
}
