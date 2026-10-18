import { formatTripInstanceRef, type TransitRef } from '../core/refs';
import type { VerificationReason } from '../core/results';
import type { NormalizedStopUpdate } from '../gtfs/realtime/decode';
import type { ScheduleShard, ScheduleStop, ScheduleTransfer, ScheduleTrip } from '../gtfs/static/schema';
import type { LoadedScheduleShard } from './schedule-index';
import { formatInstant, isServiceActive, parseInstant } from './service-day';
import type { Itinerary, ItineraryLeg, JourneyEndpoint, JourneyQuery, TransitLeg, WalkLeg } from './types';

interface Instance {
  shard: ScheduleShard; trip: ScheduleTrip; date: string; timezone: string; origin: number; start: number;
  ref: TransitLeg['tripInstanceRef']; shift: number; updates: Map<number, NormalizedStopUpdate>;
}
interface Label { stop: TransitRef; time: number; walking: number; boardings: number; legs: ItineraryLeg[]; last?: TransitLeg }
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
function transferRules(previous: TransitLeg, next: Instance, board: TransitRef, transfers: ScheduleTransfer[], stops: Map<TransitRef, ScheduleStop>): ScheduleTransfer[] {
  const matched = transfers.filter(rule => stopMatches(rule.fromStopRef, previous.to, stops) && stopMatches(rule.toStopRef, board, stops) &&
    (!rule.fromTripRef || rule.fromTripRef === previous.tripRef) && (!rule.toTripRef || rule.toTripRef === next.trip.ref) &&
    (!rule.fromRouteRef || rule.fromRouteRef === previous.routeRef) && (!rule.toRouteRef || rule.toRouteRef === next.trip.routeRef));
  const specificity = (rule: ScheduleTransfer) => (rule.fromTripRef ? 4 : 0) + (rule.toTripRef ? 4 : 0) + (rule.fromRouteRef && !rule.fromTripRef ? 1 : 0) + (rule.toRouteRef && !rule.toTripRef ? 1 : 0);
  const highest = Math.max(-1, ...matched.map(specificity));
  return matched.filter(rule => specificity(rule) === highest);
}

/** Round-based earliest-arrival scan. Each round adds one vehicle boarding;
 * block/explicit in-seat continuation is closed inside that same round.
 * Labels retain their arriving trip because transfer restrictions are trip-specific.
 * This traversal is deliberately not imported by the validator. */
export async function routeDepartAt(query: JourneyQuery, loaded: LoadedScheduleShard[], artifactVersion: string,
  realtime: NormalizedStopUpdate[], realtimeTimestamp: number | undefined, baseBytes: number, signal?: AbortSignal): Promise<RouterOutput> {
  assertNotAborted(signal);
  if (baseBytes + realtime.length * 512 >= 64 * 1024 * 1024) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
  const begin = parseInstant(query.departAt), end = begin + (query.windowSeconds ?? 7200) * 1000;
  const maxWalk = Math.min(800, query.maxWalkMetres ?? 800), maxTransfers = query.maxTransfers ?? 3;
  const stops = new Map<TransitRef, ScheduleStop>();
  const transfers: ScheduleTransfer[] = [], pathways: ScheduleShard['pathways'] = [];
  for (const { shard } of loaded) { for (const stop of shard.stops) stops.set(stop.ref, stop); transfers.push(...shard.transfers); pathways.push(...shard.pathways); }
  for (const endpoint of [query.origin, query.destination]) if (typeof endpoint === 'string' && !stops.has(endpoint)) throw new Error('ENTITY_NOT_FOUND: unknown journey stop');
  const reasons = new Set<VerificationReason>();
  const updates = new Map<string, Map<number, NormalizedStopUpdate>>();
  for (const row of realtime) if (row.tripInstanceRef && row.stopSequence !== undefined) {
    const calls = updates.get(row.tripInstanceRef) ?? new Map<number, NormalizedStopUpdate>();
    if (calls.has(row.stopSequence)) throw new Error('Ambiguous realtime stop update');
    calls.set(row.stopSequence, row); updates.set(row.tripInstanceRef, calls);
  }
  const instances: Instance[] = [], seen = new Set<string>();
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
          if (last == null || origin + (last + shift) * 1000 < begin || origin + start * 1000 >= end) return;
          const ref = formatTripInstanceRef({ coverage: shard.coverageId, feed: shard.feedId, id: trip.providerId, serviceDate: day.serviceDate, startTime: startString(start) });
          if (seen.has(ref)) return; seen.add(ref);
          instances.push({ shard, trip, date: day.serviceDate, timezone: day.timezone, origin, start, shift, ref, updates: updates.get(ref) ?? new Map() });
          if (baseBytes + instances.length * 1024 > 48 * 1024 * 1024) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
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
  const sameStation = (a: TransitRef, b: TransitRef) => (stops.get(a)?.parentStationRef ?? a) === (stops.get(b)?.parentStationRef ?? b);
  const pathwayControlled = (a: TransitRef, b: TransitRef) => pathNodes.has(a) && pathNodes.has(b) || sameStation(a, b) && [...pathNodes].some(p => sameStation(p, a));
  // Topological reachability is only used to disclose a limitation. It never
  // creates precise departures or claims that an approximate connection works.
  const reachesDestination = new Set<TransitRef>();
  if (approximate.length) {
    for (const stop of stops.values()) if (stop.ref === query.destination || distance(stop.ref, query.destination, stops) <= maxWalk) reachesDestination.add(stop.ref);
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
  let labelCount = 0, rounds = 0;
  const estimatedBytes = () => baseBytes + instances.length * 1024 + labelCount * 3072 + stops.size * 512 + realtime.length * 512;
  function countLabel() { labelCount++; if (estimatedBytes() >= 64 * 1024 * 1024) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required'); }
  const makeWalk = (from: JourneyEndpoint, to: JourneyEndpoint, time: number, metres: number, seconds = Math.ceil(metres / 1.25), pathwayId?: string): WalkLeg => ({
    kind: 'walk', from, to, departureTime: iso(time), arrivalTime: iso(time + seconds * 1000), distanceMetres: metres,
    verification: pathwayId ? 'pathway' : 'unverified', estimated: !pathwayId || seconds === undefined, ...(pathwayId ? { pathwayId } : {}),
  });
  function walkClosure(seeds: Label[]): Label[] {
    const result = [...seeds], visited = new Set<string>();
    for (let index = 0; index < result.length; index++) {
      const label = result[index]!;
      const key = `${label.stop}|${label.time}|${label.walking}|${signature(label.legs)}`;
      if (visited.has(key)) continue; visited.add(key);
      const walked = new Set<JourneyEndpoint>([label.stop]);
      for (let i = label.legs.length - 1; i >= 0 && label.legs[i]!.kind === 'walk'; i--) { walked.add(label.legs[i]!.from); walked.add(label.legs[i]!.to); }
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
      if (maxWalk > label.walking) for (const stop of stops.values()) {
        if (stop.ref === label.stop || pathwayControlled(label.stop, stop.ref)) continue;
        const metres = distance(label.stop, stop.ref, stops);
        if (metres <= maxWalk - label.walking) edges.push(makeWalk(label.stop, stop.ref, label.time, metres));
      }
      for (const leg of edges) {
        if (walked.has(leg.to) || label.walking + leg.distanceMetres > maxWalk || Date.parse(leg.arrivalTime) > end) continue;
        const next: Label = { ...label, stop: leg.to as TransitRef, time: Date.parse(leg.arrivalTime), walking: label.walking + leg.distanceMetres, legs: [...label.legs, leg] };
        countLabel(); result.push(next);
      }
    }
    return result;
  }
  let frontier: Label[] = [];
  if (typeof query.origin === 'string') frontier.push({ stop: query.origin, time: begin, walking: 0, boardings: 0, legs: [] });
  else for (const stop of stops.values()) {
    // Pathway-defined platforms are accessed through their entrance graph.
    if (pathNodes.has(stop.ref) && stop.locationType !== 2) continue;
    const metres = distance(query.origin, stop.ref, stops); if (metres > maxWalk) continue;
    const leg = makeWalk(query.origin, stop.ref, begin, metres);
    frontier.push({ stop: stop.ref, time: Date.parse(leg.arrivalTime), walking: metres, boardings: 0, legs: [leg] }); countLabel();
  }
  frontier = walkClosure(frontier);
  const finished: Label[] = [];
  const finish = (label: Label) => {
    if (!label.last) return;
    if (typeof query.destination === 'string') { if (label.stop === query.destination) finished.push(label); return; }
    if (pathNodes.has(label.stop) && stops.get(label.stop)?.locationType !== 2) return;
    const metres = distance(label.stop, query.destination, stops);
    if (metres + label.walking > maxWalk) return;
    const leg = makeWalk(label.stop, query.destination, label.time, metres);
    if (Date.parse(leg.arrivalTime) <= end) finished.push({ ...label, time: Date.parse(leg.arrivalTime), walking: label.walking + metres, legs: [...label.legs, leg] });
  };
  const timeAt = (instance: Instance, index: number, event: 'arrival' | 'departure') => {
    const call = instance.trip.stopTimes[index]!, row = instance.updates.get(call.sequence), seconds = event === 'arrival' ? call.arrivalSeconds : call.departureSeconds;
    if (seconds == null) return null;
    const predicted = row?.status === 'realtime' ? (event === 'arrival' ? row.arrivalTimeSeconds : row.departureTimeSeconds) : undefined;
    return predicted !== undefined ? predicted * 1000 : instance.origin + (seconds + instance.shift) * 1000;
  };
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
    const next: Label[] = [], stateCounts = new Map<string, Set<string>>(), terminalLabels = new Map<TransitRef, Label[]>();
    for (const instance of instances) {
      assertNotAborted(signal);
      if ([...instance.updates.values()].some(row => row.status === 'canceled' || row.scheduleRelationship === 'CANCELED')) { reasons.add('TRIP_CANCELED'); continue; }
      const calls = instance.trip.stopTimes;
      for (let board = 0; board < calls.length - 1; board++) {
        const call = calls[board]!, departure = timeAt(instance, board, 'departure');
        if (departure === null || departure < begin || departure >= end || instance.updates.get(call.sequence)?.status === 'skipped') continue;
        const explicitLinks = board === 0 ? transfers.filter(rule => rule.transferType === 4 && rule.toTripRef === instance.trip.ref).flatMap(rule => terminalLabels.get(rule.fromTripRef!) ?? []) : [];
        for (const label of new Set([...(prior.get(call.stopRef) ?? []), ...(current.get(call.stopRef) ?? []), ...explicitLinks])) {
          if (label.time > departure || label.legs.some(leg => leg.kind === 'transit' && leg.tripInstanceRef === instance.ref)) continue;
          const previous = label.last, previousInstance = previous ? byRef.get(previous.tripInstanceRef) : undefined;
          const rules = previous ? transferRules(previous, instance, call.stopRef, transfers, stops) : [];
          if (rules.some(rule => rule.transferType === 3)) continue;
          const linked = rules.some(rule => rule.transferType === 4);
          const terminal = previousInstance && previous?.alightSequence === previousInstance.trip.stopTimes.at(-1)!.sequence && board === 0;
          const block = previousInstance && label.stop === call.stopRef && blockSuccessor.get(previousInstance.ref) === instance.ref &&
            !transfers.some(rule => rule.fromTripRef === previousInstance.trip.ref && (rule.transferType === 4 || rule.transferType === 5) && rule.toTripRef !== instance.trip.ref);
          const continuation = !!(terminal && label.legs.at(-1)?.kind === 'transit' && !rules.some(rule => rule.transferType === 5) && (linked || block));
          if ((call.pickupType !== 0 || previousInstance?.trip.stopTimes.find(c => c.sequence === previous?.alightSequence)?.dropOffType !== 0 && previous) && !continuation) continue;
          const boardings = label.boardings + (continuation ? 0 : 1);
          if (boardings !== round) continue;
          const minimum = Math.max(0, ...rules.map(rule => rule.minTransferSeconds ?? 0));
          if (previous && departure - Date.parse(previous.arrivalTime) < minimum * 1000) continue;
          for (let alight = board + 1; alight < calls.length; alight++) {
            const dest = calls[alight]!, arrival = timeAt(instance, alight, 'arrival');
            if (arrival === null || arrival < departure || arrival > end || instance.updates.get(dest.sequence)?.status === 'skipped') continue;
            if (dest.dropOffType !== 0 && alight !== calls.length - 1) continue;
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
            const key = `${instance.ref}/${dest.sequence}/${candidate.walking}`, signatures = stateCounts.get(key) ?? new Set<string>(), sig = signature(candidate.legs);
            if (signatures.has(sig) || signatures.size >= 3) continue; signatures.add(sig); stateCounts.set(key, signatures);
            countLabel(); next.push(candidate);
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
  const unique = new Map<string, Label>();
  for (const label of finished) unique.set(signature(label.legs), label);
  const ordered = [...unique.values()].sort((a, b) => a.time - b.time || a.boardings - b.boardings || a.walking - b.walking || compare(signature(a.legs), signature(b.legs)));
  const candidates = ordered.filter(label => !ordered.some(other => other.time <= label.time && other.boardings <= label.boardings && other.walking <= label.walking &&
    (other.boardings < label.boardings || other.walking < label.walking))).map(label => ({
    coverageId: query.manifest.coverageId, artifactVersion, origin: query.origin, destination: query.destination, departAt: query.departAt,
    windowSeconds: query.windowSeconds ?? 7200, maxWalkMetres: maxWalk, maxTransfers, departureTime: label.legs[0]!.departureTime,
    arrivalTime: label.legs.at(-1)!.arrivalTime, walkingMetres: label.walking, transfers: label.boardings - 1,
    status: label.legs.some(leg => leg.kind === 'transit' && leg.status === 'realtime') ? 'realtime' as const : 'scheduled_only' as const, legs: label.legs,
  }));
  return { candidates, reasons: [...reasons], rounds, estimatedWorkingSetBytes: estimatedBytes() };
}
