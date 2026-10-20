import type { TransitRef } from '../core/refs';
import type { DiscoveryIndex, ScheduleShard } from '../gtfs/static/schema';
import { isServiceActive } from './service-day';

/** One schedule band reduced to what a network-wide search scans: route patterns as stop
 * index arrays and their trips' times as integers, nothing else. Stops index the feed's
 * discovery stops, times are seconds from the band's service-day origin. Patterns are
 * FIFO (no trip overtakes another), so the earliest boardable trip is a binary search.
 *
 * Layout, little endian: magic MTC1, header byte length, JSON header, zero padding to 4,
 * then Int32 arrays patternStart[P+1], patternStops[S], tripStart[P+1], times[2 per call],
 * and Uint8 arrays stopFlags[S] (1 no pickup, 2 no drop-off), wheelchair[T]. */
export interface CompactHeader {
  version: 1; coverageId: string; feedId: string; serviceDate: string;
  /** The shard this band was built from and the discovery whose stop order it indexes. */
  shardSha256: string; discoverySha256: string;
  agencies: TransitRef[]; routes: TransitRef[];
  /** Per pattern: index into routes and into agencies. */
  patternRoutes: number[]; patternAgencies: number[];
  patterns: number; stopSlots: number; trips: number;
}
export interface CompactBand {
  header: CompactHeader;
  patternStart: Int32Array; patternStops: Int32Array; stopFlags: Uint8Array;
  tripStart: Int32Array; times: Int32Array; wheelchair: Uint8Array;
  /** Where each pattern's trips begin in times (derived, not stored). */
  timeStart: Int32Array;
}
export const NO_PICKUP = 1, NO_DROP_OFF = 2;

interface Run { stops: number[]; flags: number[]; route: number; agency: number; trips: { times: number[]; wheelchair: number }[] }

/** Times for every call of a trip, filling untimed intermediate calls by straight-line
 * interpolation. The search only proposes lines; exact times come from the shard itself. */
function callTimes(stopTimes: ScheduleShard['trips'][number]['stopTimes'], shift: number): number[] | null {
  const times: number[] = new Array(stopTimes.length * 2);
  let previous = -1;
  for (let index = 0; index < stopTimes.length; index++) {
    const call = stopTimes[index]!;
    if (call.arrivalSeconds === null || call.departureSeconds === null) continue;
    if (previous < 0 && index > 0) return null;
    const before = previous >= 0 ? times[previous * 2 + 1]! : 0;
    for (let gap = previous + 1; gap < index; gap++) {
      const value = Math.round(before + (call.arrivalSeconds + shift - before) * (gap - previous) / (index - previous));
      times[gap * 2] = value; times[gap * 2 + 1] = value;
    }
    times[index * 2] = call.arrivalSeconds + shift; times[index * 2 + 1] = call.departureSeconds + shift;
    previous = index;
  }
  return previous === stopTimes.length - 1 ? times : null;
}

export function buildCompactBand(shard: ScheduleShard, discovery: DiscoveryIndex, shardSha256: string, discoverySha256: string): Uint8Array {
  if (shard.window.startDate !== shard.window.endDate || discovery.feedId !== shard.feedId) throw new Error('Compact bands hold one service date of one feed');
  const date = shard.window.startDate;
  const stopIndex = new Map(discovery.stops.map((stop, index) => [stop.ref, index]));
  const routes: TransitRef[] = [], routeIndex = new Map<TransitRef, number>();
  const agencies: TransitRef[] = [], agencyIndex = new Map<TransitRef, number>();
  const intern = (map: Map<TransitRef, number>, list: TransitRef[], ref: TransitRef) => { let at = map.get(ref); if (at === undefined) { at = list.length; list.push(ref); map.set(ref, at); } return at; };
  const routeAgency = new Map(shard.routes.map(route => [route.ref, route.agencyRef]));
  const patterns = new Map(shard.patterns.map(pattern => [pattern.id, pattern]));
  const frequencies = new Map<TransitRef, ScheduleShard['frequencies']>();
  for (const frequency of shard.frequencies) frequencies.set(frequency.tripRef, [...frequencies.get(frequency.tripRef) ?? [], frequency]);
  const groups = new Map<string, { stops: number[]; flags: number[]; route: number; agency: number; trips: Run['trips'] }>();
  for (const trip of shard.trips) {
    const calendar = shard.calendars[trip.serviceId];
    if (!calendar || !isServiceActive(calendar, date)) continue;
    const pattern = patterns.get(trip.patternId)!;
    let group = groups.get(trip.patternId);
    if (!group) {
      const stops = pattern.stopRefs.map(ref => stopIndex.get(ref) ?? -1);
      if (stops.includes(-1)) throw new Error('Compact band stop missing from discovery');
      group = { stops, flags: pattern.stopRefs.map((_, index) => (pattern.pickupTypes[index] === 1 ? NO_PICKUP : 0) | (pattern.dropOffTypes[index] === 1 ? NO_DROP_OFF : 0)),
        route: intern(routeIndex, routes, trip.routeRef), agency: intern(agencyIndex, agencies, routeAgency.get(trip.routeRef)!), trips: [] };
      groups.set(trip.patternId, group);
    }
    const first = trip.stopTimes[0]?.departureSeconds;
    if (first == null) continue;
    // Frequency trips run at every headway; non-exact ones are approximate anyway.
    const starts = (frequencies.get(trip.ref) ?? []).flatMap(interval => {
      const list: number[] = [];
      for (let start = interval.startSeconds; start < interval.endSeconds; start += interval.headwaySeconds) list.push(start);
      return list;
    });
    for (const start of starts.length ? starts : [first]) {
      const times = callTimes(trip.stopTimes, start - first);
      if (times) group.trips.push({ times, wheelchair: trip.wheelchairAccessible });
    }
  }
  // Split each pattern where one trip would overtake another, keeping every run FIFO.
  const runs: Run[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.route - b.route)) {
    group.trips.sort((a, b) => a.times[1]! - b.times[1]! || a.times.at(-2)! - b.times.at(-2)!);
    const own: Run[] = [];
    for (const trip of group.trips) {
      const run = own.find(candidate => { const last = candidate.trips.at(-1)!.times; return trip.times.every((value, index) => value >= last[index]!); });
      if (run) run.trips.push(trip);
      else own.push({ stops: group.stops, flags: group.flags, route: group.route, agency: group.agency, trips: [trip] });
    }
    runs.push(...own);
  }
  const stopSlots = runs.reduce((sum, run) => sum + run.stops.length, 0), trips = runs.reduce((sum, run) => sum + run.trips.length, 0);
  const calls = runs.reduce((sum, run) => sum + run.stops.length * run.trips.length, 0);
  const header: CompactHeader = { version: 1, coverageId: shard.coverageId, feedId: shard.feedId, serviceDate: date, shardSha256, discoverySha256,
    agencies, routes, patternRoutes: runs.map(run => run.route), patternAgencies: runs.map(run => run.agency), patterns: runs.length, stopSlots, trips };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const offset = (8 + json.length + 3) & ~3;
  const ints = (runs.length + 1) * 2 + stopSlots + calls * 2;
  const bytes = new Uint8Array(offset + ints * 4 + stopSlots + trips);
  bytes.set([77, 84, 67, 49]);
  new DataView(bytes.buffer).setUint32(4, json.length, true);
  bytes.set(json, 8);
  const words = new Int32Array(bytes.buffer, offset, ints), flags = bytes.subarray(offset + ints * 4);
  let at = 0, stopAt = 0;
  for (const run of runs) { words[at++] = stopAt; stopAt += run.stops.length; }
  words[at++] = stopAt;
  for (const run of runs) for (const stop of run.stops) words[at++] = stop;
  let tripAt = 0;
  for (const run of runs) { words[at++] = tripAt; tripAt += run.trips.length; }
  words[at++] = tripAt;
  for (const run of runs) for (const trip of run.trips) for (const value of trip.times) words[at++] = value;
  let flagAt = 0;
  for (const run of runs) for (const flag of run.flags) flags[flagAt++] = flag;
  for (const run of runs) for (const trip of run.trips) flags[flagAt++] = trip.wheelchair;
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('Compact bands assume a little-endian host');
  return bytes;
}

/** Views over the bytes, no copy. The caller checks the object's identity against the
 * manifest (shard and discovery hashes) before use. */
export function parseCompactBand(bytes: Uint8Array): CompactBand {
  if (bytes.length < 8 || bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 67 || bytes[3] !== 49) throw new Error('Invalid compact band');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as CompactHeader;
  if (header.version !== 1 || header.patternRoutes.length !== header.patterns || header.patternAgencies.length !== header.patterns) throw new Error('Invalid compact band');
  // Int32 views need 4-byte alignment; a fetched buffer is aligned, a slice may not be.
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  const offset = aligned.byteOffset + ((8 + length + 3) & ~3), P = header.patterns, S = header.stopSlots;
  const patternStart = new Int32Array(aligned.buffer, offset, P + 1);
  const patternStops = new Int32Array(aligned.buffer, offset + (P + 1) * 4, S);
  const tripStart = new Int32Array(aligned.buffer, offset + (P + 1 + S) * 4, P + 1);
  const timeStart = new Int32Array(P + 1);
  let calls = 0;
  for (let pattern = 0; pattern < P; pattern++) { timeStart[pattern] = calls * 2; calls += (patternStart[pattern + 1]! - patternStart[pattern]!) * (tripStart[pattern + 1]! - tripStart[pattern]!); }
  timeStart[P] = calls * 2;
  const ints = (P + 1) * 2 + S + calls * 2;
  if (patternStart[P] !== S || tripStart[P] !== header.trips || aligned.byteLength !== ((8 + length + 3) & ~3) + ints * 4 + S + header.trips) throw new Error('Invalid compact band');
  const times = new Int32Array(aligned.buffer, offset + ((P + 1) * 2 + S) * 4, calls * 2);
  const stopFlags = new Uint8Array(aligned.buffer, offset + ints * 4, S), wheelchair = new Uint8Array(aligned.buffer, offset + ints * 4 + S, header.trips);
  return { header, patternStart, patternStops, stopFlags, tripStart, times, wheelchair, timeStart };
}
