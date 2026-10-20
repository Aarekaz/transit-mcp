import type { TransitRef } from '../core/refs';
import type { DiscoveryIndex } from '../gtfs/static/schema';
import { NO_DROP_OFF, NO_PICKUP, type CompactBand } from './compact';
import type { JourneyEndpoint } from './types';

/** Every stop of a coverage's feeds, numbered feed by feed in discovery order, with a
 * coarse grid for walking neighbours. Built once per set of discovery indexes. */
export interface NetworkStops {
  refs: TransitRef[]; latitude: Float64Array; longitude: Float64Array;
  /** Index of the parent station, or -1. */
  parent: Int32Array; feedBase: Map<string, number>;
  cells: Map<number, number[]>;
}
/** Bands loaded for one search, with each band agency's service-day origin as an epoch
 * second (undefined: that agency is outside this search). */
export interface NetworkBand { band: CompactBand; origins: (number | undefined)[] }
export interface NetworkQuery {
  stops: NetworkStops; bands: NetworkBand[];
  origin: JourneyEndpoint; destination: JourneyEndpoint;
  /** Epoch seconds; journeys arrive by end. */
  begin: number; end: number;
  maxWalkMetres: number; maxTransfers: number;
  /** Step-free: board and alight only at these stops, never on a trip marked inaccessible. */
  usableStops?: ReadonlySet<TransitRef>;
}
export interface NetworkRide { routeRef: TransitRef; from: TransitRef; to: TransitRef; departure: number; arrival: number }
export interface NetworkJourney { arrival: number; departure: number; rides: NetworkRide[] }

const WALK_SPEED = 1.25, CELL_DEGREES = 0.005, INFINITY = 0x7fffffff;
/** Walking bands per search: labels differ by at most a quarter of the walking limit. */
const WALK_BANDS = 5;
/** Vehicle changes take at least this long; walking changes take their walk. */
const CHANGE_SECONDS = 60;
/** Changes between lines walk at most this far; access and egress use the full walk limit. */
const TRANSFER_METRES = 500;

const cellKey = (latitude: number, longitude: number) => Math.floor(latitude / CELL_DEGREES) * 100000 + Math.floor(longitude / CELL_DEGREES);
function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * radians / 2) ** 2 + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return Math.ceil(6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h))));
}

const stopCache = new WeakMap<readonly DiscoveryIndex[], NetworkStops>();
export function networkStops(indexes: readonly DiscoveryIndex[]): NetworkStops {
  const cached = stopCache.get(indexes); if (cached) return cached;
  const total = indexes.reduce((sum, index) => sum + index.stops.length, 0);
  const refs: TransitRef[] = new Array(total), latitude = new Float64Array(total).fill(NaN), longitude = new Float64Array(total).fill(NaN);
  const parent = new Int32Array(total).fill(-1), feedBase = new Map<string, number>(), position = new Map<TransitRef, number>(), cells = new Map<number, number[]>();
  let at = 0;
  for (const index of indexes) {
    feedBase.set(index.feedId, at);
    for (const stop of index.stops) {
      refs[at] = stop.ref; position.set(stop.ref, at);
      if (stop.latitude != null && stop.longitude != null) {
        latitude[at] = stop.latitude; longitude[at] = stop.longitude;
        const key = cellKey(stop.latitude, stop.longitude), cell = cells.get(key);
        if (cell) cell.push(at); else cells.set(key, [at]);
      }
      at++;
    }
  }
  for (const index of indexes) for (const stop of index.stops) if (stop.parentStationRef) parent[position.get(stop.ref)!] = position.get(stop.parentStationRef) ?? -1;
  const result = { refs, latitude, longitude, parent, feedBase, cells };
  stopCache.set(indexes, result);
  return result;
}

/** Stops within `limit` metres of a point, by grid lookup. */
function near(stops: NetworkStops, lat: number, lon: number, limit: number): { stop: number; metres: number }[] {
  const result: { stop: number; metres: number }[] = [];
  const spanLat = Math.ceil(limit / 111000 / CELL_DEGREES), spanLon = Math.ceil(limit / (111000 * Math.cos(lat * Math.PI / 180)) / CELL_DEGREES);
  const row = Math.floor(lat / CELL_DEGREES), column = Math.floor(lon / CELL_DEGREES);
  for (let dLat = -spanLat; dLat <= spanLat; dLat++) for (let dLon = -spanLon; dLon <= spanLon; dLon++) {
    for (const stop of stops.cells.get((row + dLat) * 100000 + column + dLon) ?? []) {
      const distance = metres(lat, lon, stops.latitude[stop]!, stops.longitude[stop]!);
      if (distance <= limit) result.push({ stop, metres: distance });
    }
  }
  return result;
}

/** Stops an endpoint reaches and the metres walked to each: a stop ref is itself (a station,
 * its platforms) plus what lies within walking distance; coordinates, what lies within it. */
function endpointStops(stops: NetworkStops, endpoint: JourneyEndpoint, limit: number, position: (ref: TransitRef) => number | undefined): Map<number, number> {
  const found = new Map<number, number>();
  const add = (stop: number, metres: number) => { if (metres < (found.get(stop) ?? Infinity)) found.set(stop, metres); };
  let lat: number, lon: number;
  if (typeof endpoint === 'string') {
    const self = position(endpoint);
    if (self === undefined) return found;
    add(self, 0);
    for (let stop = 0; stop < stops.parent.length; stop++) if (stops.parent[stop] === self) add(stop, 0);
    lat = stops.latitude[self]!; lon = stops.longitude[self]!;
    if (Number.isNaN(lat)) return found;
  } else ({ latitude: lat, longitude: lon } = endpoint);
  for (const { stop, metres: distance } of near(stops, lat, lon, limit)) add(stop, distance);
  return found;
}

interface Pattern { band: CompactBand; local: number; offset: number; route: number }

/** Round-based earliest arrival (RAPTOR) over every pattern in the loaded bands, buses
 * included. One arrival per stop, round and walking band: it proposes which lines to ride, and the exact
 * planner then builds and validates the journey along them. Returns the Pareto set over
 * arrival and rides, earliest first. */
export function searchNetwork(query: NetworkQuery, bannedRoutes: ReadonlySet<TransitRef> = new Set()): NetworkJourney[] {
  const { stops } = query, N = stops.refs.length, K = query.maxTransfers + 1, window = query.end - query.begin;
  const positions = new Map<TransitRef, number>();
  const position = (ref: TransitRef) => { if (!positions.size) stops.refs.forEach((value, index) => positions.set(value, index)); return positions.get(ref); };
  const usable = query.usableStops && new Uint8Array(N);
  if (usable) for (const ref of query.usableStops!) { const at = position(ref); if (at !== undefined) usable[at] = 1; }
  // Patterns that run inside the window, with times shifted to seconds from begin.
  const patterns: Pattern[] = [], routeRefs: TransitRef[] = [], routeIds = new Map<TransitRef, number>();
  for (const { band, origins } of query.bands) {
    const base = stops.feedBase.get(band.header.feedId);
    if (base === undefined) continue;
    for (let local = 0; local < band.header.patterns; local++) {
      const origin = origins[band.header.patternAgencies[local]!];
      const routeRef = band.header.routes[band.header.patternRoutes[local]!]!;
      if (origin === undefined || bannedRoutes.has(routeRef)) continue;
      const offset = origin - query.begin, width = (band.patternStart[local + 1]! - band.patternStart[local]!) * 2;
      const first = band.timeStart[local]!, last = band.timeStart[local + 1]! - 1;
      if (band.times[last]! + offset < 0 || band.times[first + 1]! + offset > window) continue;
      if (width === 0) continue;
      let route = routeIds.get(routeRef);
      if (route === undefined) { route = routeRefs.length; routeRefs.push(routeRef); routeIds.set(routeRef, route); }
      patterns.push({ band, local, offset, route });
    }
  }
  // Stop -> (pattern, position) occurrences, compressed rows.
  const counts = new Int32Array(N + 1);
  for (const { band, local } of patterns) {
    const base = stops.feedBase.get(band.header.feedId)!;
    for (let at = band.patternStart[local]!; at < band.patternStart[local + 1]!; at++) counts[base + band.patternStops[at]! + 1]!++;
  }
  for (let stop = 0; stop < N; stop++) counts[stop + 1]! += counts[stop]!;
  const occurrences = new Int32Array(counts[N]! * 2), fill = counts.slice(0, N);
  patterns.forEach(({ band, local }, index) => {
    const base = stops.feedBase.get(band.header.feedId)!, startAt = band.patternStart[local]!;
    for (let at = startAt; at < band.patternStart[local + 1]!; at++) { const slot = fill[base + band.patternStops[at]!]!++ * 2; occurrences[slot] = index; occurrences[slot + 1] = at - startAt; }
  });

  const access = endpointStops(stops, query.origin, query.maxWalkMetres, position);
  const egress = endpointStops(stops, query.destination, query.maxWalkMetres, position);
  // Walking is a limit, not a cost: the earliest arrival at a stop may have walked too far
  // to finish, while a later one has not. Labels are kept per walking band (WALK_BANDS of
  // the limit), each band dominating only those that walked more.
  const B = query.maxWalkMetres > 0 ? WALK_BANDS : 1, width = query.maxWalkMetres / Math.max(1, B - 1), S = B * N;
  const band = (metres: number) => metres <= 0 ? 0 : Math.min(B - 1, Math.ceil(metres / width));
  // At [round*S + band*N + stop]: tau, the earliest arrival with at most `round` rides; walk,
  // the metres walked. Parents: kind 0 carried from round-1, 1 ride (pattern, board
  // position, trip), 2 walk (from slot), 3 access. best[band*N + stop]: earliest arrival in
  // any band up to this one.
  const tau = new Int32Array((K + 1) * S).fill(INFINITY), best = new Int32Array(S).fill(INFINITY), walk = new Int32Array((K + 1) * S);
  const kind = new Uint8Array((K + 1) * S), parentA = new Int32Array((K + 1) * S), parentB = new Int32Array((K + 1) * S), parentC = new Int32Array((K + 1) * S);
  const improve = (slot: number, arrival: number) => { const stop = slot % N; for (let at = Math.floor(slot / N); at < B; at++) if (arrival < best[at * N + stop]!) best[at * N + stop] = arrival; };
  let marked: number[] = [];
  for (const [stop, distance] of access) {
    const slot = band(distance) * N + stop, arrival = Math.ceil(distance / WALK_SPEED);
    if (arrival >= best[slot]!) continue;
    tau[slot] = arrival; walk[slot] = distance; kind[slot] = 3; improve(slot, arrival); marked.push(slot);
  }
  let target = INFINITY;
  const targets: { round: number; arrival: number; slot: number }[] = [];
  const queue = new Int32Array(patterns.length).fill(-1);
  const trip = new Int32Array(B), boardAt = new Int32Array(B);
  for (let round = 1; round <= K && marked.length; round++) {
    const row = round * S, previous = (round - 1) * S;
    tau.copyWithin(row, previous, previous + S); walk.copyWithin(row, previous, previous + S);
    const touched: number[] = [];
    for (const slot of marked) { const stop = slot % N; for (let at = counts[stop]!; at < counts[stop + 1]!; at++) {
      const pattern = occurrences[at * 2]!, index = occurrences[at * 2 + 1]!;
      if (queue[pattern] === -1) { touched.push(pattern); queue[pattern] = index; }
      else if (index < queue[pattern]!) queue[pattern] = index;
    } }
    const improved: number[] = [];
    for (const index of touched) {
      const { band: data, local, offset } = patterns[index]!, from = queue[index]!; queue[index] = -1;
      const base = stops.feedBase.get(data.header.feedId)!, stopAt = data.patternStart[local]!, length = data.patternStart[local + 1]! - stopAt;
      const firstTrip = data.tripStart[local]!, tripCount = data.tripStart[local + 1]! - firstTrip, timeAt = data.timeStart[local]!, span = length * 2;
      trip.fill(-1);
      for (let at = from; at < length; at++) {
        const stop = base + data.patternStops[stopAt + at]!, flags = data.stopFlags[stopAt + at]!;
        const alight = !(flags & NO_DROP_OFF) && (!usable || usable[stop]), pickup = !(flags & NO_PICKUP) && (!usable || usable[stop]);
        // A ride keeps the walking of its boarding: one trip being ridden per band.
        for (let walked = 0; walked < B; walked++) {
          const slot = walked * N + stop, current = trip[walked]!;
          if (current >= 0 && alight) {
            const arrival = data.times[timeAt + current * span + at * 2]! + offset;
            if (arrival < best[slot]! && arrival < target && arrival <= window) {
              tau[row + slot] = arrival; improve(slot, arrival);
              kind[row + slot] = 1; parentA[row + slot] = index; parentB[row + slot] = boardAt[walked]!; parentC[row + slot] = current;
              walk[row + slot] = walk[previous + walked * N + base + data.patternStops[stopAt + boardAt[walked]!]!]!;
              improved.push(slot);
            }
          }
          const ready = tau[previous + slot]!;
          if (ready === INFINITY || !pickup) continue;
          const earliest = ready + (round > 1 && kind[previous + slot] === 1 ? CHANGE_SECONDS : 0);
          if (current >= 0 && data.times[timeAt + current * span + at * 2 + 1]! + offset < earliest) continue;
          // FIFO: departures at this position rise with the trip index.
          let low = 0, high = current >= 0 ? current : tripCount;
          while (low < high) { const middle = (low + high) >> 1; if (data.times[timeAt + middle * span + at * 2 + 1]! + offset < earliest) low = middle + 1; else high = middle; }
          if (usable) while (low < tripCount && data.wheelchair[firstTrip + low] === 2) low++;
          if (low < tripCount && (current < 0 || low <= current)) { trip[walked] = low; boardAt[walked] = at; }
        }
      }
    }
    // Walk on from each stop a ride improved, once; walks never chain.
    const reached = new Set<number>(improved);
    for (const slot of new Set(improved)) {
      const stop = slot % N, walked = walk[row + slot]!;
      if (Number.isNaN(stops.latitude[stop]!)) continue;
      const budget = Math.min(TRANSFER_METRES, query.maxWalkMetres - walked);
      if (budget <= 0) continue;
      for (const { stop: next, metres: distance } of near(stops, stops.latitude[stop]!, stops.longitude[stop]!, budget)) {
        const arrival = tau[row + slot]! + Math.ceil(distance / WALK_SPEED), to = band(walked + distance) * N + next;
        if (next === stop || arrival >= best[to]! || arrival >= target) continue;
        tau[row + to] = arrival; improve(to, arrival); kind[row + to] = 2; parentA[row + to] = slot; walk[row + to] = walked + distance; reached.add(to);
      }
    }
    for (const slot of reached) if (kind[row + slot] === 0) reached.delete(slot);
    marked = [...reached];
    let roundBest = INFINITY, roundSlot = -1;
    for (const [stop, distance] of egress) for (let walked = 0; walked < B; walked++) {
      const slot = walked * N + stop, arrival = tau[row + slot]! + Math.ceil(distance / WALK_SPEED);
      if (kind[row + slot] !== 0 && tau[row + slot] !== INFINITY && walk[row + slot]! + distance <= query.maxWalkMetres && arrival < roundBest) { roundBest = arrival; roundSlot = slot; }
    }
    if (roundSlot >= 0 && roundBest < target && roundBest <= window) { target = roundBest; targets.push({ round, arrival: roundBest, slot: roundSlot }); }
  }
  const journeys: NetworkJourney[] = [];
  for (const found of targets) {
    const rides: NetworkRide[] = [];
    let slot = found.slot, round = found.round;
    for (let guard = 0; round > 0 && guard < 4 * K + 4; guard++) {
      const at = round * S + slot;
      if (kind[at] === 0) { round--; continue; }
      if (kind[at] === 2) { slot = parentA[at]!; continue; }
      if (kind[at] !== 1) break;
      const { band: data, local, offset, route } = patterns[parentA[at]!]!, stopAt = data.patternStart[local]!, span = (data.patternStart[local + 1]! - stopAt) * 2;
      const timeAt = data.timeStart[local]! + parentC[at]! * span, boarding = parentB[at]!, base = stops.feedBase.get(data.header.feedId)!;
      const board = base + data.patternStops[stopAt + boarding]!;
      rides.unshift({ routeRef: routeRefs[route]!, from: stops.refs[board]!, to: stops.refs[slot % N]!, departure: query.begin + data.times[timeAt + boarding * 2 + 1]! + offset, arrival: query.begin + tau[at]! });
      slot = slot - (slot % N) + board; round--;
    }
    if (rides.length) journeys.push({ arrival: query.begin + found.arrival, departure: rides[0]!.departure, rides });
  }
  return journeys.sort((a, b) => a.arrival - b.arrival || a.rides.length - b.rides.length);
}
