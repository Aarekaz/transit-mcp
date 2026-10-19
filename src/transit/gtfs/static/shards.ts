import type { DiscoveryIndex, ScheduleShard } from './schema';
import { z } from 'zod';
import { parseTransitRef, type TransitRef } from '../../core/refs';
import { parseServiceDate } from './time';

const id = z.string().min(1);
const uint = z.number().int().min(0).max(0xfffffffe);
const time = z.number().int().min(0).max(999 * 3600 + 3599).nullable();
const reference = (kind: 'agency' | 'stop' | 'route' | 'trip') => z.custom<TransitRef>(value => typeof value === 'string' && parseTransitRef(value)?.kind === kind && value.split(':').length === 5);
const agencyRef = reference('agency'), stopRef = reference('stop'), routeRef = reference('route'), tripRef = reference('trip');
const direction = z.number().int().min(0).max(1).nullable();
const date = z.string().refine(value => { try { parseServiceDate(value); return true; } catch { return false; } });
const timezone = id.refine(value => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const calendar = z.object({
  monday: z.boolean(), tuesday: z.boolean(), wednesday: z.boolean(), thursday: z.boolean(),
  friday: z.boolean(), saturday: z.boolean(), sunday: z.boolean(),
  startDate: z.union([date, z.literal('00000000')]), endDate: z.union([date, z.literal('99999999')]),
  exceptions: z.record(date, z.union([z.literal(1), z.literal(2)])),
});
const tripIdentity = { ref: tripRef, providerId: id, routeRef, serviceId: id };
const metadataSchema = z.object({
  schemaVersion: z.literal(2), coverageId: id, feedId: id,
  maxStopTimeSeconds: uint.max(2 * (999 * 3600 + 3599)),
  window: z.object({ startDate: date, endDate: date }).refine(value => value.startDate <= value.endDate),
  timeRange: z.object({ bandStart: uint, bandEnd: uint, start: uint, end: uint })
    .refine(value => value.bandStart < value.bandEnd && value.start <= value.end).optional(),
  source: z.object({ feedId: id, url: z.url(), retrievedAt: id.refine(value => Number.isFinite(Date.parse(value))), sha256: hash, archiveSha256: hash.optional(),
    derivedFrom: z.object({ archiveSha256: hash, excludedFiles: z.array(id).min(1), reason: z.string().min(1).max(500) }).optional(),
    feedInfo: z.array(z.record(z.string(), z.string())), anonymousAgencyRef: agencyRef.optional() }),
  agencyTimezones: z.record(agencyRef, timezone),
  stops: z.array(z.object({ ref: stopRef, providerId: id, name: z.string(), latitude: z.number().nullable(), longitude: z.number().nullable(),
    locationType: uint.max(4), parentStationRef: stopRef.optional(), wheelchairBoarding: uint.max(2) })),
  routes: z.array(z.object({ ref: routeRef, providerId: id, agencyRef, shortName: z.string(), longName: z.string(),
    mode: z.enum(['tram', 'subway', 'rail', 'bus', 'ferry', 'cable_tram', 'aerial', 'funicular', 'trolleybus', 'monorail']),
    routeType: uint, color: z.string(), textColor: z.string() })),
  trips: z.array(z.object({ ...tripIdentity, patternId: hash, headsign: z.string(), directionId: direction,
    blockId: z.string(), wheelchairAccessible: uint.max(2), bikesAllowed: uint.max(2) })),
  patterns: z.array(z.object({ id: hash, routeRef, directionId: direction, stopRefs: z.array(stopRef).min(1),
    pickupTypes: z.array(uint.max(3)), dropOffTypes: z.array(uint.max(3)) })),
  calendars: z.record(id, calendar),
  frequencies: z.array(z.object({ tripRef, startSeconds: time, endSeconds: time, headwaySeconds: uint.min(1), exactTimes: uint.max(1) })),
  blocks: z.record(id, z.array(tripRef)),
  transfers: z.array(z.object({ fromStopRef: stopRef.optional(), toStopRef: stopRef.optional(), fromRouteRef: routeRef.optional(), toRouteRef: routeRef.optional(),
    fromTripRef: tripRef.optional(), toTripRef: tripRef.optional(), transferType: uint.max(5), minTransferSeconds: uint.nullable() })),
  pathways: z.array(z.object({ id, fromStopRef: stopRef, toStopRef: stopRef, mode: uint.max(7), bidirectional: z.boolean(),
    lengthMetres: z.number().nullable(), traversalSeconds: uint.nullable(), stairCount: z.number().nullable(), maxSlope: z.number().nullable(),
    minWidthMetres: z.number().nullable(), signpostedAs: z.string(), reversedSignpostedAs: z.string() })),
  transferBoundaryTrips: z.array(z.object({ ...tripIdentity, firstDepartureSeconds: time, lastArrivalSeconds: time })),
  headsigns: z.array(z.string()),
});

const discoverySchema = metadataSchema.pick({ schemaVersion: true, coverageId: true, feedId: true, stops: true, routes: true }).extend({
  sourceSha256: hash,
  tripProviderIds: z.array(id).refine(ids => ids.every((value, index) => index === 0 || ids[index - 1]! < value)),
  stopRoutes: z.record(stopRef, z.array(routeRef)),
  stationLinks: z.array(z.tuple([stopRef, stopRef])).optional(),
});

/** The caller verifies descriptor hash/length and manifest source identity. */
export function decodeDiscoveryIndex(bytes: Uint8Array): DiscoveryIndex {
  try {
    const discovery = discoverySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
    for (const record of [...discovery.stops, ...discovery.routes]) {
      const ref = parseTransitRef(record.ref)!;
      if (ref.coverage !== discovery.coverageId || ref.feed !== discovery.feedId || ref.id !== record.providerId) throw new Error();
    }
    return discovery;
  } catch { throw new Error('Invalid discovery index'); }
}

/** Locale-independent canonical JSON is used only for the metadata section. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  });
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Little endian: magic MTS2, metadata byte length, row count, row width.
// Followed by canonical metadata, zero padding to 4 bytes, then Uint32 rows:
// trip index, stop index, sequence, arrival, departure, pickup, dropoff,
// timepoint, headsign string index. 0xffffffff represents an unknown time.
const HEADER_BYTES = 16;
const ROW_WORDS = 9;
const UNKNOWN_TIME = 0xffffffff;

export function encodeScheduleShard(shard: ScheduleShard): Uint8Array {
  const stopIndexes = new Map(shard.stops.map((stop, index) => [stop.ref, index]));
  const headsigns = [...new Set(shard.trips.flatMap(trip => trip.stopTimes.map(time => time.headsign)))].sort();
  const headsignIndexes = new Map(headsigns.map((value, index) => [value, index]));
  const rows: number[] = [];
  const trips = shard.trips.map((trip, tripIndex) => {
    const { stopTimes, ...metadata } = trip;
    for (const time of stopTimes) {
      const stopIndex = stopIndexes.get(time.stopRef);
      if (stopIndex === undefined) throw new Error('Timetable references an unknown stop');
      rows.push(tripIndex, stopIndex, time.sequence, time.arrivalSeconds ?? UNKNOWN_TIME,
        time.departureSeconds ?? UNKNOWN_TIME, time.pickupType, time.dropOffType, time.timepoint, headsignIndexes.get(time.headsign)!);
    }
    return metadata;
  });
  const metadata = new TextEncoder().encode(canonicalJson({ ...shard, trips, headsigns }));
  const offset = (HEADER_BYTES + metadata.length + 3) & ~3;
  const bytes = new Uint8Array(offset + rows.length * 4);
  bytes.set([77, 84, 83, 50]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, metadata.length, true);
  view.setUint32(8, rows.length / ROW_WORDS, true);
  view.setUint32(12, ROW_WORDS, true);
  bytes.set(metadata, HEADER_BYTES);
  rows.forEach((value, index) => view.setUint32(offset + index * 4, value, true));
  return bytes;
}

/** Checks metadata shape, local references, patterns and timetable invariants.
 * The loader must first verify the manifest hash and byte budget. Source truth,
 * GTFS semantic validation and report authenticity remain producer boundaries. */
export function decodeScheduleShard(bytes: Uint8Array): ScheduleShard {
  try {
    if (bytes.length < HEADER_BYTES || bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 83 || bytes[3] !== 50) throw new Error();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metadataLength = view.getUint32(4, true), rowCount = view.getUint32(8, true);
    const offset = Math.ceil((HEADER_BYTES + metadataLength) / 4) * 4;
    if (view.getUint32(12, true) !== ROW_WORDS || offset + rowCount * ROW_WORDS * 4 !== bytes.length) throw new Error();
    const metadata = metadataSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength))));
    const { headsigns, ...rest } = metadata;
    const shard: ScheduleShard = { ...rest, trips: rest.trips.map(trip => ({ ...trip, stopTimes: [] })),
      frequencies: rest.frequencies.map(frequency => {
        if (frequency.startSeconds === null || frequency.endSeconds === null || frequency.endSeconds <= frequency.startSeconds) throw new Error();
        return { ...frequency, startSeconds: frequency.startSeconds, endSeconds: frequency.endSeconds };
      }) };
    if (shard.source.feedId !== shard.feedId) throw new Error();
    const indexed = <T extends { ref: TransitRef }>(values: T[]) => {
      const map = new Map(values.map(value => [value.ref, value]));
      if (map.size !== values.length) throw new Error();
      for (const value of values) {
        const parsed = parseTransitRef(value.ref)!;
        if (parsed.coverage !== shard.coverageId || parsed.feed !== shard.feedId) throw new Error();
      }
      return map;
    };
    const stops = indexed(shard.stops), routes = indexed(shard.routes), trips = indexed(shard.trips);
    const boundaries = indexed(shard.transferBoundaryTrips);
    for (const boundary of boundaries.values()) if (trips.has(boundary.ref) || !routes.has(boundary.routeRef) || !Object.hasOwn(shard.calendars, boundary.serviceId)) throw new Error();
    for (const stop of stops.values()) if (stop.parentStationRef && !stops.has(stop.parentStationRef)) throw new Error();
    for (const route of routes.values()) if (!Object.hasOwn(shard.agencyTimezones, route.agencyRef)) throw new Error();
    const patterns = new Map(shard.patterns.map(pattern => [pattern.id, pattern]));
    if (patterns.size !== shard.patterns.length) throw new Error();
    for (const pattern of patterns.values()) {
      if (!routes.has(pattern.routeRef) || pattern.stopRefs.some(ref => !stops.has(ref)) ||
        pattern.pickupTypes.length !== pattern.stopRefs.length || pattern.dropOffTypes.length !== pattern.stopRefs.length) throw new Error();
    }
    for (const trip of trips.values()) if (!routes.has(trip.routeRef) || !patterns.has(trip.patternId) || !Object.hasOwn(shard.calendars, trip.serviceId)) throw new Error();
    for (const frequency of shard.frequencies) if (!trips.has(frequency.tripRef)) throw new Error();
    for (const block of Object.values(shard.blocks)) if (block.some(ref => !trips.has(ref))) throw new Error();
    for (const transfer of shard.transfers) {
      if ([transfer.fromStopRef, transfer.toStopRef].some(ref => ref && !stops.has(ref)) ||
        [transfer.fromRouteRef, transfer.toRouteRef].some(ref => ref && !routes.has(ref)) ||
        [transfer.fromTripRef, transfer.toTripRef].some(ref => ref && !trips.has(ref) && !boundaries.has(ref))) throw new Error();
    }
    for (const pathway of shard.pathways) if (!stops.has(pathway.fromStopRef) || !stops.has(pathway.toStopRef)) throw new Error();
    const lastDepartures = new Map<TransitRef, number>();
    let lastTripIndex = -1;
    for (let row = 0; row < rowCount; row++) {
      const word = (column: number) => view.getUint32(offset + (row * ROW_WORDS + column) * 4, true);
      const trip = shard.trips[word(0)], stop = shard.stops[word(1)], headsign = headsigns[word(8)];
      if (!trip || !stop || typeof headsign !== 'string' || word(5) > 3 || word(6) > 3 || word(7) > 1) throw new Error();
      const arrivalSeconds = word(3) === UNKNOWN_TIME ? null : word(3);
      const departureSeconds = word(4) === UNKNOWN_TIME ? null : word(4);
      const previous = trip.stopTimes.at(-1);
      if (word(0) < lastTripIndex) throw new Error();
      lastTripIndex = word(0);
      if (previous && previous.sequence >= word(2)) throw new Error();
      if ((arrivalSeconds === null) !== (departureSeconds === null) ||
        (arrivalSeconds !== null && departureSeconds !== null && (departureSeconds < arrivalSeconds || arrivalSeconds < (lastDepartures.get(trip.ref) ?? 0) || departureSeconds > 999 * 3600 + 3599))) throw new Error();
      if (departureSeconds !== null) lastDepartures.set(trip.ref, departureSeconds);
      if (departureSeconds !== null && departureSeconds > shard.maxStopTimeSeconds) throw new Error();
      trip.stopTimes.push({ stopRef: stop.ref, sequence: word(2), arrivalSeconds, departureSeconds,
        pickupType: word(5), dropOffType: word(6), timepoint: word(7), headsign });
    }
    for (const trip of shard.trips) {
      const pattern = patterns.get(trip.patternId)!;
      if (!trip.stopTimes.length || trip.stopTimes.length !== pattern.stopRefs.length || pattern.routeRef !== trip.routeRef || pattern.directionId !== trip.directionId ||
        trip.stopTimes.some((time, index) => time.stopRef !== pattern.stopRefs[index] || time.pickupType !== pattern.pickupTypes[index] || time.dropOffType !== pattern.dropOffTypes[index])) throw new Error();
    }
    for (const boundary of shard.transferBoundaryTrips) {
      if ((boundary.firstDepartureSeconds ?? 0) > shard.maxStopTimeSeconds || (boundary.lastArrivalSeconds ?? 0) > shard.maxStopTimeSeconds) throw new Error();
    }
    if (shard.timeRange) {
      // A band must contain exactly what its descriptor claims; selection relies on it.
      if (shard.window.startDate !== shard.window.endDate || shard.frequencies.length || Object.keys(shard.blocks).length || shard.transferBoundaryTrips.length) throw new Error();
      for (const trip of shard.trips) {
        const first = trip.stopTimes[0]!.departureSeconds;
        if (first === null || first < shard.timeRange.bandStart || first >= shard.timeRange.bandEnd || first < shard.timeRange.start) throw new Error();
        if (trip.stopTimes.some(call => Math.max(call.arrivalSeconds ?? 0, call.departureSeconds ?? 0) > shard.timeRange!.end)) throw new Error();
      }
    }
    for (const frequency of shard.frequencies) {
      const trip = trips.get(frequency.tripRef)!;
      const first = trip.stopTimes[0]!.departureSeconds, last = trip.stopTimes.at(-1)!.departureSeconds;
      if (first !== null && last !== null && frequency.endSeconds - (frequency.exactTimes === 1 ? 1 : 0) + last - first > shard.maxStopTimeSeconds) throw new Error();
    }
    return shard;
  } catch {
    throw new Error('Invalid schedule shard');
  }
}
