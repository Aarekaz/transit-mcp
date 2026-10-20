import { formatTripInstanceRef, parseTransitRef, type TransitRef } from '../core/refs';
import type { VerificationReason } from '../core/results';
import type { NormalizedStopUpdate } from '../gtfs/realtime/decode';
import type { ScheduleShard, ScheduleStop, ScheduleTransfer, ScheduleTrip } from '../gtfs/static/schema';
import { canonicalJson } from '../gtfs/static/shards';
import { parseGtfsTime } from '../gtfs/static/time';
import type { LoadedScheduleShard } from './schedule-index';
import { formatInstant, isServiceActive, parseInstant } from './service-day';
import type { Itinerary, ItineraryLeg, JourneyEndpoint, JourneyQuery, TransitLeg, WalkLeg } from './types';

interface Instance {
  shard: ScheduleShard; trip: ScheduleTrip; date: string; timezone: string; origin: number; start: number;
  ref: TransitLeg['tripInstanceRef']; shift: number; updates: Map<number, NormalizedStopUpdate>;
}
interface Label { stop: TransitRef; time: number; walking: number; boardings: number; legs: ItineraryLeg[]; last?: TransitLeg;
  /** Interned ids of the leg sequence and of its transit legs: equal ids, equal sequences. */
  signature?: number; transitKey?: number }
export interface RouterOutput { candidates: Itinerary[]; reasons: VerificationReason[]; rounds: number; estimatedWorkingSetBytes: number }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const signature = (legs: ItineraryLeg[]) => legs.map(l => l.kind === 'transit' ? `${l.tripInstanceRef}/${l.boardSequence}/${l.alightSequence}` : `${JSON.stringify(l.from)}/${JSON.stringify(l.to)}/${l.pathwayId ?? ''}`).join('|');
const iso = (time: number, timezone = 'UTC') => formatInstant(time, timezone);
const startString = (seconds: number) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
export function assertNotAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Journey request aborted', 'AbortError'); }

function coordinates(endpoint: JourneyEndpoint, stops: Map<TransitRef, ScheduleStop>): { latitude: number; longitude: number } | null {
  if (typeof endpoint !== 'string') return endpoint;
  const stop = stops.get(endpoint);
  return stop?.latitude != null && stop.longitude != null ? { latitude: stop.latitude, longitude: stop.longitude } : null;
}
function distance(from: JourneyEndpoint, to: JourneyEndpoint, stops: Map<TransitRef, ScheduleStop>): number {
  const a = coordinates(from, stops), b = coordinates(to, stops); if (!a || !b) return Infinity;
  const radians = Math.PI / 180;
  const h = Math.sin((b.latitude - a.latitude) * radians / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin((b.longitude - a.longitude) * radians / 2) ** 2;
  return Math.ceil(6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h))));
}
function stopMatches(rule: TransitRef | undefined, stop: TransitRef, stops: Map<TransitRef, ScheduleStop>): boolean {
  return !rule || rule === stop || rule === stops.get(stop)?.parentStationRef;
}
/** Rules keyed by destination stop ('' = any). A boarding can only match rules naming its
 * stop, its parent station, or no stop, so lookups never scan the whole table. */
function indexTransfers(transfers: ScheduleTransfer[]): Map<string, ScheduleTransfer[]> {
  const index = new Map<string, ScheduleTransfer[]>();
  for (const rule of transfers) { const key = rule.toStopRef ?? '', list = index.get(key) ?? []; list.push(rule); index.set(key, list); }
  return index;
}
function transferRules(previous: TransitLeg, next: Instance, board: TransitRef, index: Map<string, ScheduleTransfer[]>, stops: Map<TransitRef, ScheduleStop>): ScheduleTransfer[] {
  const parent = stops.get(board)?.parentStationRef;
  const candidates = [...index.get(board) ?? [], ...parent ? index.get(parent) ?? [] : [], ...index.get('') ?? []];
  if (!candidates.length) return candidates;
  const matched = candidates.filter(rule => stopMatches(rule.fromStopRef, previous.to, stops) && stopMatches(rule.toStopRef, board, stops) &&
    (!rule.fromTripRef || rule.fromTripRef === previous.tripRef) && (!rule.toTripRef || rule.toTripRef === next.trip.ref) &&
    (!rule.fromRouteRef || rule.fromRouteRef === previous.routeRef) && (!rule.toRouteRef || rule.toRouteRef === next.trip.routeRef));
  const specificity = (rule: ScheduleTransfer) => (rule.fromTripRef ? 4 : 0) + (rule.toTripRef ? 4 : 0) + (rule.fromRouteRef && !rule.fromTripRef ? 1 : 0) + (rule.toRouteRef && !rule.toTripRef ? 1 : 0);
  const highest = Math.max(-1, ...matched.map(specificity));
  return matched.filter(rule => specificity(rule) === highest);
}

/** Estimated working set one search may reach. The estimate runs about 1.65x the heap it
 * measures: NYC Inwood-207 St to Coney Island, the longest subway trip, estimates 70 MB and
 * retains 32 MB beyond its decoded shards. This leaves most of a 128 MB isolate to the
 * shards, realtime feed, discovery index and runtime. */
const ROUTER_BUDGET_BYTES = 96 * 1024 * 1024;

/** Round-based earliest-arrival scan. Each round adds one vehicle boarding;
 * block/explicit in-seat continuation is closed inside that same round.
 * Labels retain their arriving trip because transfer restrictions are trip-specific.
 * This traversal is deliberately not imported by the validator. */
export async function routeDepartAt(query: JourneyQuery, loaded: LoadedScheduleShard[], artifactVersion: string,
  realtime: NormalizedStopUpdate[], realtimeTimestamp: number | undefined, baseBytes: number, signal?: AbortSignal): Promise<RouterOutput> {
  assertNotAborted(signal);
  // Rows already live in the decoded feed; the router only adds an index entry
  // that references each one. Charging per-row copies refused every NYC rush-hour plan.
  const realtimeBytes = realtime.length * 128;
  if (baseBytes + realtimeBytes >= ROUTER_BUDGET_BYTES) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
  const begin = parseInstant(query.departAt), end = begin + (query.windowSeconds ?? 7200) * 1000;
  const maxWalk = Math.min(800, query.maxWalkMetres ?? 800), maxTransfers = query.maxTransfers ?? 3;
  const stops = new Map<TransitRef, ScheduleStop>();
  const transfers: ScheduleTransfer[] = [], pathways: ScheduleShard['pathways'] = [];
  const pathwayDefinitions = new Map<string, string>(), transferKeys = new Set<string>();
  for (const { shard } of loaded) {
    for (const stop of shard.stops) stops.set(stop.ref, stop);
    // Every time band of a feed repeats the feed's transfer table; keep one copy of each rule.
    for (const rule of shard.transfers) { const key = canonicalJson(rule); if (!transferKeys.has(key)) { transferKeys.add(key); transfers.push(rule); } }
    for (const pathway of shard.pathways) {
      const key = `${shard.feedId}/${shard.source.sha256}/${pathway.id}`, definition = canonicalJson(pathway);
      const previous = pathwayDefinitions.get(key);
      if (previous !== undefined && previous !== definition) throw new Error('Conflicting canonical pathway definitions');
      if (previous === undefined) { pathwayDefinitions.set(key, definition); pathways.push(pathway); }
    }
  }
  // Time bands carry only the stops they serve. The tool resolves endpoints against the
  // feed's discovery index first, so an endpoint absent here has no service in this window.
  if ([query.origin, query.destination].some(endpoint => typeof endpoint === 'string' && !stops.has(endpoint))) {
    return { candidates: [], reasons: [], rounds: 0, estimatedWorkingSetBytes: baseBytes + realtimeBytes };
  }
  if (baseBytes + realtimeBytes + stops.size * 512 >= ROUTER_BUDGET_BYTES) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
  const reasons = new Set<VerificationReason>();
  const updates = new Map<string, Map<number, NormalizedStopUpdate>>();
  const observedStarts = new Map<string, Set<number>>();
  for (const row of realtime) if (row.tripInstanceRef && row.stopSequence !== undefined) {
    const calls = updates.get(row.tripInstanceRef) ?? new Map<number, NormalizedStopUpdate>();
    if (calls.has(row.stopSequence)) throw new Error('Ambiguous realtime stop update');
    calls.set(row.stopSequence, row); updates.set(row.tripInstanceRef, calls);
    const parsed = parseTransitRef(row.tripInstanceRef);
    if (parsed?.kind === 'trip' && 'serviceDate' in parsed) {
      const key = `${parsed.feed}/${parsed.id}/${parsed.serviceDate}`, starts = observedStarts.get(key) ?? new Set<number>();
      starts.add(parseGtfsTime(parsed.startTime).totalSeconds); observedStarts.set(key, starts);
    }
  }
  const instances: Instance[] = [], seen = new Set<string>();
  let instanceBytes = 0;
  const approximate: { trip: ScheduleTrip; origin: number; start: number; end: number }[] = [];
  for (const { shard, serviceDays } of loaded) {
    const routes = new Map(shard.routes.map(route => [route.ref, route]));
    for (const trip of shard.trips) {
      const route = routes.get(trip.routeRef)!, first = trip.stopTimes[0]?.departureSeconds;
      if (first == null) continue;
      const intervals = shard.frequencies.filter(f => f.tripRef === trip.ref);
      for (const day of serviceDays) {
        if (route.agencyRef !== day.agencyRef || !isServiceActive(shard.calendars[trip.serviceId]!, day.serviceDate)) continue;
        const origin = parseInstant(day.startTime);
        const add = (start: number) => {
          const shift = start - first, last = trip.stopTimes.at(-1)!.arrivalSeconds;
          const ref = formatTripInstanceRef({ coverage: shard.coverageId, feed: shard.feedId, id: trip.providerId, serviceDate: day.serviceDate, startTime: startString(start) });
          const tripUpdates = updates.get(ref);
          if (!tripUpdates && (last == null || origin + (last + shift) * 1000 < begin || origin + start * 1000 >= end)) return;
          if (tripUpdates) {
            let canBoard = false, overlaps = false;
            for (const call of trip.stopTimes) {
              const update = tripUpdates.get(call.sequence);
              const arrival = update?.status === 'realtime' && update.arrivalTimeSeconds !== undefined ? update.arrivalTimeSeconds * 1000 : call.arrivalSeconds === null ? null : origin + (call.arrivalSeconds + shift) * 1000;
              const departure = update?.status === 'realtime' && update.departureTimeSeconds !== undefined ? update.departureTimeSeconds * 1000 : call.departureSeconds === null ? null : origin + (call.departureSeconds + shift) * 1000;
              if (canBoard && arrival !== null && arrival >= begin && arrival <= end) overlaps = true;
              if (departure !== null && departure >= begin && departure < end) canBoard = true;
            }
            if (!overlaps) return;
          }
          if (seen.has(ref)) return;
          const charge = 1024 + ref.length * 8;
          if (baseBytes + realtimeBytes + stops.size * 512 + instanceBytes + charge >= 48 * 1024 * 1024) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
          instanceBytes += charge; seen.add(ref);
          instances.push({ shard, trip, date: day.serviceDate, timezone: day.timezone, origin, start, shift, ref, updates: tripUpdates ?? new Map() });
        };
        if (!intervals.length) add(first);
        for (const interval of intervals) {
          const lastOffset = (trip.stopTimes.at(-1)!.arrivalSeconds ?? first) - first;
          if (interval.exactTimes !== 1) {
            if (origin + interval.startSeconds * 1000 < end && origin + (interval.endSeconds + lastOffset) * 1000 > begin) {
              approximate.push({ trip, origin, start: interval.startSeconds, end: interval.endSeconds });
            }
            continue;
          }
          const index = Math.max(0, Math.ceil(((begin - origin) / 1000 - lastOffset - interval.startSeconds) / interval.headwaySeconds));
          for (let start = interval.startSeconds + index * interval.headwaySeconds; start < interval.endSeconds && origin + start * 1000 < end; start += interval.headwaySeconds) add(start);
        }
        for (const start of observedStarts.get(`${shard.feedId}/${trip.providerId}/${day.serviceDate}`) ?? []) {
          if (intervals.some(interval => interval.exactTimes === 1 && start >= interval.startSeconds && start < interval.endSeconds && (start - interval.startSeconds) % interval.headwaySeconds === 0)) add(start);
        }
      }
    }
  }
  instances.sort((a, b) => a.origin + a.start * 1000 - b.origin - b.start * 1000 || compare(a.ref, b.ref));
  const byRef = new Map(instances.map(instance => [instance.ref, instance]));
  const blockSuccessor = new Map<string, string>();
  const blocks = new Map<string, Instance[]>();
  for (const instance of instances) if (instance.trip.blockId) {
    const key = `${instance.shard.feedId}/${instance.date}/${instance.trip.blockId}`;
    const block = blocks.get(key) ?? []; block.push(instance); blocks.set(key, block);
  }
  for (const block of blocks.values()) for (let index = 0; index < block.length - 1; index++) blockSuccessor.set(block[index]!.ref, block[index + 1]!.ref);
  const pathNodes = new Set(pathways.flatMap(p => [p.fromStopRef, p.toStopRef]));
  // Parent stations and explicit pathways define complexes. Street estimates may
  // connect distinct entrances, but cannot bypass the internal access graph.
  const roots = new Map<TransitRef, TransitRef>();
  const root = (ref: TransitRef): TransitRef => {
    let result = ref;
    while (roots.has(result)) result = roots.get(result)!;
    let node = ref;
    while (roots.has(node)) { const parent = roots.get(node)!; roots.set(node, result); node = parent; }
    return result;
  };
  const join = (a: TransitRef, b: TransitRef) => { const left = root(a), right = root(b); if (left !== right) roots.set(right, left); };
  for (const stop of stops.values()) if (stop.parentStationRef) join(stop.ref, stop.parentStationRef);
  for (const pathway of pathways) join(pathway.fromStopRef, pathway.toStopRef);
  const controlled = new Set([...pathNodes].map(root));
  const exteriorAccess = (ref: TransitRef) => !controlled.has(root(ref)) || stops.get(ref)?.locationType === 2;
  const pathwayControlled = (a: TransitRef, b: TransitRef) => root(a) === root(b) && controlled.has(root(a)) || !exteriorAccess(a) || !exteriorAccess(b);
  // Topological reachability is only used to disclose a limitation. It never
  // creates precise departures or claims that an approximate connection works.
  const reachesDestination = new Set<TransitRef>();
  if (approximate.length) {
    for (const stop of stops.values()) if (stop.ref === query.destination || typeof query.destination === 'string' && stop.parentStationRef === query.destination ||
      distance(stop.ref, query.destination, stops) <= maxWalk) reachesDestination.add(stop.ref);
    const patterns = [...instances.map(instance => instance.trip), ...approximate.map(item => item.trip)];
    let changed = true;
    while (changed) {
      changed = false;
      const add = (ref: TransitRef) => { if (!reachesDestination.has(ref)) { reachesDestination.add(ref); changed = true; } };
      for (const trip of patterns) {
        let downstream = false;
        for (let index = trip.stopTimes.length - 1; index >= 0; index--) {
          const call = trip.stopTimes[index]!;
          if (downstream && call.pickupType === 0) add(call.stopRef);
          if (call.dropOffType === 0 && reachesDestination.has(call.stopRef)) downstream = true;
        }
      }
      for (const path of pathways) {
        if (reachesDestination.has(path.toStopRef)) add(path.fromStopRef);
        if (path.bidirectional && reachesDestination.has(path.fromStopRef)) add(path.toStopRef);
      }
    }
  }
  let retainedLabelBytes = 0, neighbourBytes = 0, rounds = 0;
  // Hash-consed leg sequences. Every label extends its parent by one leg, so a sequence is
  // interned as (parent id, leg id) and labels hold integers instead of a ~500-character
  // signature each. Full text is built only for finished journeys, to order ties.
  const legIds = new Map<string, number>(), legIdOf = new WeakMap<ItineraryLeg, number>(), pathIds = new Map<string, number>();
  const legId = (leg: ItineraryLeg) => {
    let id = legIdOf.get(leg);
    if (id === undefined) {
      const piece = signature([leg]);
      id = legIds.get(piece);
      if (id === undefined) { id = legIds.size + 1; legIds.set(piece, id); }
      legIdOf.set(leg, id);
    }
    return id;
  };
  const pathId = (legs: ItineraryLeg[], transitOnly = false) => {
    let id = 0;
    for (const leg of legs) {
      if (transitOnly && leg.kind !== 'transit') continue;
      const key = `${id}:${legId(leg)}`;
      let next = pathIds.get(key);
      if (next === undefined) { next = pathIds.size + 1; pathIds.set(key, next); }
      id = next;
    }
    return id;
  };
  const estimatedBytes = () => baseBytes + instanceBytes + retainedLabelBytes + neighbourBytes + stops.size * 512 + realtimeBytes;
  // Labels share leg objects by reference: charge each retained leg once (object overhead
  // plus its exact UTF-16 text, which also bounds its interned piece), and every label for
  // its own path array, two interned path entries, state-map keys and queue/sort slots.
  // Never rely on a fixed bytes/label.
  const chargedLegs = new WeakSet<ItineraryLeg>();
  /** Checks the charge; only retain() commits leg charges, so a pre-checked candidate
   * that is later deduplicated never leaves its leg text uncounted. Without signature
   * text yet, each leg is bounded by its own string fields (legBytes). */
  function labelCharge(label: Label): number {
    let legBytes = 0;
    for (const leg of label.legs) {
      if (chargedLegs.has(leg)) continue;
      legBytes += 512 + Object.values(leg).reduce<number>((size, value) => size + (typeof value === 'string' ? value.length * 2 : 32), 0);
    }
    const charge = 1024 + label.legs.length * 64 + 2 * 96 + legBytes;
    if (label.legs.length > 100 || estimatedBytes() + charge >= ROUTER_BUDGET_BYTES) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
    return charge;
  }
  // Per-stop Pareto bags (RAPTOR): a label at least as late, with as many boardings and
  // as much walking as K retained labels at that stop cannot lead anywhere they cannot.
  // K > 1 keeps distinct alternatives for the three returned itineraries.
  const PARETO_ALTERNATIVES = 3;
  const bags = new Map<TransitRef, Label[]>();
  // Target pruning: once K distinct journeys reach the destination, a label already
  // later than the K-th arrival cannot become a returned itinerary.
  const arrivals = new Map<number, number>();
  let cutoff = Infinity; // Recomputed only when a journey finishes, never per check.
  const arrived = (label: Label) => {
    const key = label.signature!; arrivals.set(key, Math.min(arrivals.get(key) ?? Infinity, label.time));
    if (arrivals.size >= PARETO_ALTERNATIVES) cutoff = [...arrivals.values()].sort((a, b) => a - b)[PARETO_ALTERNATIVES - 1]!;
  };
  const dominated = (label: Label) => label.time > cutoff || (bags.get(label.stop) ?? []).filter(other =>
    other.time <= label.time && other.boardings <= label.boardings && other.walking <= label.walking).length >= PARETO_ALTERNATIVES;
  function retain(label: Label): Label {
    const bag = bags.get(label.stop) ?? []; bag.push(label); bags.set(label.stop, bag);
    label.signature = pathId(label.legs);
    label.transitKey = pathId(label.legs, true);
    retainedLabelBytes += labelCharge(label);
    for (const leg of label.legs) chargedLegs.add(leg);
    return label;
  }
  const makeWalk = (from: JourneyEndpoint, to: JourneyEndpoint, time: number, metres: number, seconds = Math.ceil(metres / 1.25), pathwayId?: string): WalkLeg => ({
    kind: 'walk', from, to, departureTime: iso(time), arrivalTime: iso(time + seconds * 1000), distanceMetres: metres,
    verification: pathwayId ? 'pathway' : 'unverified', estimated: !pathwayId || seconds === undefined, ...(pathwayId ? { pathwayId } : {}),
  });
  // Street walks a stop can make within the request's walking limit, computed once per stop.
  // A street walk ends where something can happen: a boardable stop, or an entrance into
  // a published pathway graph. Stations, generic nodes and boarding areas are reached only
  // through their own stops or pathways.
  const walkTarget = (stop: ScheduleStop) => stop.locationType === 0 || stop.locationType === 2 && pathNodes.has(stop.ref);
  const neighbours = new Map<TransitRef, { ref: TransitRef; metres: number }[]>();
  const walkNeighbours = (from: TransitRef) => {
    let list = neighbours.get(from);
    if (!list) {
      list = [];
      for (const stop of stops.values()) {
        if (stop.ref === from || !walkTarget(stop) || pathwayControlled(from, stop.ref)) continue;
        const metres = distance(from, stop.ref, stops);
        if (metres <= maxWalk) list.push({ ref: stop.ref, metres });
      }
      neighbourBytes += 128 + list.length * 64;
      if (estimatedBytes() >= ROUTER_BUDGET_BYTES) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
      neighbours.set(from, list);
    }
    return list;
  };
  function walkClosure(seeds: Label[]): Label[] {
    const queue: Label[] = [], states = new Map<string, Label[]>();
    const stateKey = (label: Label) => `${label.stop}/${label.boardings}/${label.transitKey}/${label.legs.at(-1)?.kind === 'transit' ? 'onboard' : 'walking'}`;
    const offer = (label: Label, retained: boolean) => {
      const key = stateKey(label), bucket = states.get(key) ?? [];
      // Equal resources have identical future transfer possibilities. Keeping
      // the first deterministic representative collapses zero-cost permutations.
      if (bucket.some(other => other.time <= label.time && other.walking <= label.walking) || !retained && dominated(label)) return;
      states.set(key, [...bucket.filter(other => !(label.time <= other.time && label.walking <= other.walking)), label]);
      if (!retained) retain(label);
      queue.push(label);
    };
    seeds.forEach(label => offer(label, true));
    for (let index = 0; index < queue.length; index++) {
      const label = queue[index]!;
      if (!states.get(stateKey(label))?.includes(label)) continue;
      const edges: WalkLeg[] = [];
      for (const path of pathways) {
        const to = path.fromStopRef === label.stop ? path.toStopRef : path.bidirectional && path.toStopRef === label.stop ? path.fromStopRef : undefined;
        if (!to) continue;
        const metres = Math.ceil(path.lengthMetres ?? distance(label.stop, to, stops));
        const seconds = path.traversalSeconds ?? Math.ceil(metres / 1.25);
        if (!Number.isFinite(metres) || !Number.isFinite(seconds)) continue;
        const leg = makeWalk(label.stop, to, label.time, metres, seconds, path.id); leg.estimated = path.traversalSeconds === null;
        edges.push(leg);
      }
      if (maxWalk > label.walking) for (const { ref, metres } of walkNeighbours(label.stop)) {
        if (metres > maxWalk - label.walking) continue;
        // Prune on numbers before formatting any leg text.
        const time = label.time + Math.ceil(metres / 1.25) * 1000;
        if (time > end || dominated({ stop: ref, time, walking: label.walking + metres, boardings: label.boardings, legs: [] })) continue;
        edges.push(makeWalk(label.stop, ref, label.time, metres));
      }
      for (const leg of edges) {
        if (label.walking + leg.distanceMetres > maxWalk || Date.parse(leg.arrivalTime) > end) continue;
        const next: Label = { ...label, stop: leg.to as TransitRef, time: Date.parse(leg.arrivalTime), walking: label.walking + leg.distanceMetres, legs: [...label.legs, leg] };
        offer(next, false);
      }
    }
    return [...states.values()].flat();
  }
  let frontier: Label[] = [];
  // GTFS stations (location_type 1) contain their platforms: being at the station is
  // being at any child stop, with no invented walk between them.
  const within = (stop: TransitRef, endpoint: TransitRef) => stop === endpoint || stops.get(endpoint)?.locationType === 1 && stops.get(stop)?.parentStationRef === endpoint;
  if (typeof query.origin === 'string') {
    for (const stop of stops.values()) if (within(stop.ref, query.origin)) frontier.push(retain({ stop: stop.ref, time: begin, walking: 0, boardings: 0, legs: [] }));
  }
  else for (const stop of stops.values()) {
    // Pathway-defined platforms are accessed through their entrance graph.
    if (!exteriorAccess(stop.ref) || !walkTarget(stop)) continue;
    const metres = distance(query.origin, stop.ref, stops); if (metres > maxWalk) continue;
    const leg = makeWalk(query.origin, stop.ref, begin, metres);
    frontier.push(retain({ stop: stop.ref, time: Date.parse(leg.arrivalTime), walking: metres, boardings: 0, legs: [leg] }));
  }
  frontier = walkClosure(frontier);
  const finished: Label[] = [];
  const finish = (label: Label) => {
    if (!label.last) return;
    if (typeof query.destination === 'string') { if (within(label.stop, query.destination)) { finished.push(label); arrived(label); } return; }
    if (!exteriorAccess(label.stop)) return;
    const metres = distance(label.stop, query.destination, stops);
    if (metres + label.walking > maxWalk) return;
    const leg = makeWalk(label.stop, query.destination, label.time, metres);
    if (Date.parse(leg.arrivalTime) <= end) { const done = retain({ ...label, time: Date.parse(leg.arrivalTime), walking: label.walking + metres, legs: [...label.legs, leg] }); finished.push(done); arrived(done); }
  };
  const timeAt = (instance: Instance, index: number, event: 'arrival' | 'departure') => {
    const call = instance.trip.stopTimes[index]!, row = instance.updates.get(call.sequence), seconds = event === 'arrival' ? call.arrivalSeconds : call.departureSeconds;
    if (seconds == null) return null;
    const predicted = row?.status === 'realtime' ? (event === 'arrival' ? row.arrivalTimeSeconds : row.departureTimeSeconds) : undefined;
    return predicted !== undefined ? predicted * 1000 : instance.origin + (seconds + instance.shift) * 1000;
  };
  const transferIndex = indexTransfers(transfers), stepFree = query.stepFree;
  const inSeatTo = new Map<TransitRef, ScheduleTransfer[]>(), inSeatFrom = new Map<TransitRef, ScheduleTransfer[]>();
  for (const rule of transfers) {
    if (rule.transferType === 4 && rule.toTripRef) inSeatTo.set(rule.toTripRef, [...inSeatTo.get(rule.toTripRef) ?? [], rule]);
    if ((rule.transferType === 4 || rule.transferType === 5) && rule.fromTripRef) inSeatFrom.set(rule.fromTripRef, [...inSeatFrom.get(rule.fromTripRef) ?? [], rule]);
  }
  for (let round = 1; round <= maxTransfers + 1 && frontier.length; round++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0)); assertNotAborted(signal); rounds = round;
    for (const interval of approximate) for (const label of frontier) {
      const calls = interval.trip.stopTimes, first = calls[0]!.departureSeconds!;
      const boarding = calls.findIndex(call => call.stopRef === label.stop && call.pickupType === 0 && call.departureSeconds !== null &&
        interval.origin + (interval.end + call.departureSeconds - first) * 1000 > label.time);
      if (boarding >= 0 && calls.slice(boarding + 1).some(call => call.dropOffType === 0 && reachesDestination.has(call.stopRef))) reasons.add('SCHEDULE_APPROXIMATE');
    }
    const prior = new Map<TransitRef, Label[]>(), current = new Map<TransitRef, Label[]>();
    for (const label of frontier) { const list = prior.get(label.stop) ?? []; list.push(label); prior.set(label.stop, list); }
    const next: Label[] = [], stateCounts = new Map<string, Set<number>>(), terminalLabels = new Map<TransitRef, Label[]>();
    for (const instance of instances) {
      assertNotAborted(signal);
      if ([...instance.updates.values()].some(row => row.status === 'canceled' || row.scheduleRelationship === 'CANCELED')) { reasons.add('TRIP_CANCELED'); continue; }
      if (stepFree && instance.trip.wheelchairAccessible === 2) continue;
      const calls = instance.trip.stopTimes;
      for (let board = 0; board < calls.length - 1; board++) {
        const call = calls[board]!, departure = timeAt(instance, board, 'departure');
        if (departure === null || departure < begin || departure >= end || instance.updates.get(call.sequence)?.status === 'skipped') continue;
        const explicitLinks = board === 0 ? (inSeatTo.get(instance.trip.ref) ?? []).flatMap(rule => terminalLabels.get(rule.fromTripRef!) ?? []) : [];
        for (const label of new Set([...(prior.get(call.stopRef) ?? []), ...(current.get(call.stopRef) ?? []), ...explicitLinks])) {
          if (label.time > departure || label.legs.some(leg => leg.kind === 'transit' && leg.tripInstanceRef === instance.ref)) continue;
          const previous = label.last, previousInstance = previous ? byRef.get(previous.tripInstanceRef) : undefined;
          const rules = previous ? transferRules(previous, instance, call.stopRef, transferIndex, stops) : [];
          if (rules.some(rule => rule.transferType === 3)) continue;
          const linked = rules.some(rule => rule.transferType === 4);
          const terminal = previousInstance && previous?.alightSequence === previousInstance.trip.stopTimes.at(-1)!.sequence && board === 0;
          const block = previousInstance && label.stop === call.stopRef && blockSuccessor.get(previousInstance.ref) === instance.ref &&
            !(inSeatFrom.get(previousInstance.trip.ref) ?? []).some(rule => rule.toTripRef !== instance.trip.ref);
          const continuation = !!(terminal && label.legs.at(-1)?.kind === 'transit' && !rules.some(rule => rule.transferType === 5) && (linked || block));
          if ((call.pickupType !== 0 || previousInstance?.trip.stopTimes.find(c => c.sequence === previous?.alightSequence)?.dropOffType !== 0 && previous) && !continuation) continue;
          if (stepFree && !continuation && !stepFree.usableStopRefs.has(call.stopRef)) continue;
          const boardings = label.boardings + (continuation ? 0 : 1);
          if (boardings !== round) continue;
          const minimum = Math.max(0, ...rules.map(rule => rule.minTransferSeconds ?? 0));
          if (previous && departure - Date.parse(previous.arrivalTime) < minimum * 1000) continue;
          for (let alight = board + 1; alight < calls.length; alight++) {
            const dest = calls[alight]!, arrival = timeAt(instance, alight, 'arrival');
            if (arrival === null || arrival < departure || arrival > end || instance.updates.get(dest.sequence)?.status === 'skipped') continue;
            if (dest.dropOffType !== 0 && alight !== calls.length - 1) continue;
            if (stepFree && !stepFree.usableStopRefs.has(dest.stopRef)) continue;
            // Prune on numbers before formatting any leg text.
            if (dominated({ stop: dest.stopRef, time: arrival, walking: label.walking, boardings, legs: [] })) continue;
            const predicted = instance.updates.get(call.sequence)?.status === 'realtime' && instance.updates.get(call.sequence)?.departureTimeSeconds !== undefined ||
              instance.updates.get(dest.sequence)?.status === 'realtime' && instance.updates.get(dest.sequence)?.arrivalTimeSeconds !== undefined;
            const leg: TransitLeg = { kind: 'transit', from: call.stopRef, to: dest.stopRef, tripRef: instance.trip.ref, tripInstanceRef: instance.ref,
              serviceDate: instance.date, instanceStartSeconds: instance.start, routeRef: instance.trip.routeRef, directionId: instance.trip.directionId,
              headsign: call.headsign || instance.trip.headsign, boardSequence: call.sequence, alightSequence: dest.sequence,
              scheduledDepartureTime: iso(instance.origin + (call.departureSeconds! + instance.shift) * 1000, instance.timezone),
              scheduledArrivalTime: iso(instance.origin + (dest.arrivalSeconds! + instance.shift) * 1000, instance.timezone),
              departureTime: iso(departure, instance.timezone), arrivalTime: iso(arrival, instance.timezone), status: predicted ? 'realtime' : 'scheduled_only',
              ...(predicted ? { realtimeTimestampSeconds: realtimeTimestamp } : {}), scheduleVersion: instance.shard.source.sha256, continuation };
            const candidate: Label = { stop: dest.stopRef, time: arrival, walking: label.walking, boardings, legs: [...label.legs, leg], last: leg };
            // Check variable string/path allocation before constructing a new
            // signature, including candidates that are later deduplicated.
            labelCharge(candidate);
            const key = `${instance.ref}/${dest.sequence}/${candidate.walking}/${label.transitKey}`, signatures = stateCounts.get(key) ?? new Set<number>(), sig = pathId(candidate.legs);
            if (signatures.has(sig) || signatures.size >= 3) continue; signatures.add(sig); stateCounts.set(key, signatures);
            retain(candidate); next.push(candidate);
            const sameRound = current.get(dest.stopRef) ?? []; sameRound.push(candidate); current.set(dest.stopRef, sameRound);
            if (alight === calls.length - 1) {
              const terminals = terminalLabels.get(instance.trip.ref) ?? []; terminals.push(candidate); terminalLabels.set(instance.trip.ref, terminals);
            }
          }
        }
      }
    }
    frontier = walkClosure(next.filter(label => {
      const trip = byRef.get(label.last!.tripInstanceRef)!.trip;
      return trip.stopTimes.find(call => call.sequence === label.last!.alightSequence)!.dropOffType === 0;
    }));
    frontier.forEach(finish);
  }
  const unique = new Map<number, Label>();
  for (const label of finished) unique.set(label.signature!, label);
  const text = new Map([...unique.values()].map(label => [label, signature(label.legs)]));
  const ordered = [...unique.values()].sort((a, b) => a.time - b.time || a.boardings - b.boardings || a.walking - b.walking || compare(text.get(a)!, text.get(b)!));
  const candidates = ordered.map(label => ({
    coverageId: query.manifest.coverageId, artifactVersion, origin: query.origin, destination: query.destination, departAt: query.departAt,
    windowSeconds: query.windowSeconds ?? 7200, maxWalkMetres: maxWalk, maxTransfers, departureTime: label.legs[0]!.departureTime,
    arrivalTime: label.legs.at(-1)!.arrivalTime, walkingMetres: label.walking, transfers: label.boardings - 1,
    status: label.legs.filter(leg => leg.kind === 'transit').every(leg => leg.status === 'realtime') ? 'realtime' as const : 'scheduled_only' as const, legs: label.legs,
  }));
  return { candidates, reasons: [...reasons], rounds, estimatedWorkingSetBytes: estimatedBytes() };
}
