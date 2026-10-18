import { formatTripInstanceRef, parseTransitRef, type TransitRef } from '../core/refs';
import { sameStaticVersion, staticVersion } from '../gtfs/realtime/snapshot-store';
import type { ScheduleShard, ScheduleStop, ScheduleTrip } from '../gtfs/static/schema';
import { isServiceActive, parseInstant, serviceDayOrigin } from './service-day';
import type { Itinerary, JourneyEndpoint, TransitLeg, ValidationResult, ValidationSource } from './types';

interface CheckedRide { leg: TransitLeg; trip: ScheduleTrip; shard: ScheduleShard; board: number; alight: number }

/** Independent proof over canonical GTFS rows. No router import, labels, route
 * indexes, scan order, predecessor graph or candidate-repair path is used. */
export async function validateItinerary(itinerary: Itinerary, source: ValidationSource, signal?: AbortSignal): Promise<ValidationResult> {
  const abort = () => { if (signal?.aborted) throw new DOMException('Journey validation aborted', 'AbortError'); };
  abort();
  const reasons = new Set<string>();
  const reject = (reason: string) => { reasons.add(reason); };
  try {
    const version = await staticVersion(source.manifest); abort();
    if (itinerary.coverageId !== source.manifest.coverageId || itinerary.artifactVersion !== version.artifactVersion) reject('SCHEDULE_VERSION');
    const requested = parseInstant(itinerary.departAt), now = parseInstant(source.now) / 1000;
    if (!Number.isInteger(itinerary.windowSeconds) || itinerary.windowSeconds < 1 || itinerary.windowSeconds > 7 * 86400 ||
      !Number.isFinite(itinerary.maxWalkMetres) || itinerary.maxWalkMetres < 0 || itinerary.maxWalkMetres > 800 ||
      !Number.isInteger(itinerary.maxTransfers) || itinerary.maxTransfers < 0 || itinerary.maxTransfers > 4) reject('QUERY_LIMITS');
    const snapshot = source.realtime, stamp = snapshot?.producerTimestampSeconds;
    const fresh = snapshot && sameStaticVersion(snapshot.version, version) && !snapshot.degraded && snapshot.payload !== null &&
      stamp !== undefined && Number.isFinite(stamp) && stamp > 0 && stamp <= now && now - stamp <= (source.realtimeMaxAgeSeconds ?? 90) &&
      Number.isFinite(snapshot.receivedAtSeconds) && snapshot.receivedAtSeconds >= stamp && snapshot.receivedAtSeconds <= now;
    const rows = fresh ? snapshot.payload! : [];
    const allStops = source.shards.flatMap(shard => shard.stops);
    const stop = (ref: TransitRef): ScheduleStop | undefined => allStops.find(value => value.ref === ref);
    const endpointEqual = (a: JourneyEndpoint, b: JourneyEndpoint) => typeof a === 'string' || typeof b === 'string' ? a === b : a.latitude === b.latitude && a.longitude === b.longitude;
    const point = (value: JourneyEndpoint) => typeof value === 'string' ? stop(value) : value;
    const metresBetween = (from: JourneyEndpoint, to: JourneyEndpoint) => {
      const a = point(from), b = point(to);
      if (a?.latitude == null || a.longitude == null || b?.latitude == null || b.longitude == null) return Infinity;
      const latA = a.latitude * Math.PI / 180, latB = b.latitude * Math.PI / 180;
      const haversine = (1 - Math.cos(latB - latA)) / 2 + Math.cos(latA) * Math.cos(latB) * (1 - Math.cos((b.longitude - a.longitude) * Math.PI / 180)) / 2;
      return Math.ceil(12742000 * Math.atan2(Math.sqrt(Math.max(0, haversine)), Math.sqrt(Math.max(0, 1 - haversine))));
    };
    const validEndpoint = (endpoint: JourneyEndpoint) => {
      if (typeof endpoint === 'string') { const parsed = parseTransitRef(endpoint); return parsed?.kind === 'stop' && parsed.coverage === itinerary.coverageId && !!stop(endpoint) && endpoint.split(':').length === 5; }
      return Number.isFinite(endpoint.latitude) && Math.abs(endpoint.latitude) <= 90 && Number.isFinite(endpoint.longitude) && Math.abs(endpoint.longitude) <= 180;
    };
    if (!validEndpoint(itinerary.origin) || !validEndpoint(itinerary.destination)) reject('ENDPOINT');
    if (!itinerary.legs.length || itinerary.legs.length > 100) return { valid: false, reasons: ['LEG_COUNT'] };
    if (!endpointEqual(itinerary.legs[0]!.from, itinerary.origin) || !endpointEqual(itinerary.legs.at(-1)!.to, itinerary.destination)) reject('ENDPOINT');
    let previousTime = requested, walked = 0, changes = -1, realtime = false;
    let previousRide: CheckedRide | undefined;
    const checked: CheckedRide[] = [];
    for (let index = 0; index < itinerary.legs.length; index++) {
      abort();
      const leg = itinerary.legs[index]!, previous = itinerary.legs[index - 1];
      const depart = parseInstant(leg.departureTime), arrive = parseInstant(leg.arrivalTime);
      if (depart < previousTime || arrive < depart || arrive > requested + itinerary.windowSeconds * 1000) reject('TIME_ORDER');
      previousTime = arrive;
      if (previous && !endpointEqual(previous.to, leg.from) && !(leg.kind === 'transit' && leg.continuation)) reject('DISCONNECTED_LEGS');
      if (!validEndpoint(leg.from) || !validEndpoint(leg.to)) reject('ENDPOINT');
      if (leg.kind === 'walk') {
        if (!Number.isFinite(leg.distanceMetres) || leg.distanceMetres < 0) { reject('WALK_DISTANCE'); continue; }
        walked += leg.distanceMetres;
        let expectedDistance = metresBetween(leg.from, leg.to), expectedSeconds = Math.ceil(expectedDistance / 1.25);
        if (leg.verification === 'pathway') {
          const paths = source.shards.flatMap(shard => shard.pathways).filter(path => path.id === leg.pathwayId &&
            (path.fromStopRef === leg.from && path.toStopRef === leg.to || path.bidirectional && path.toStopRef === leg.from && path.fromStopRef === leg.to));
          if (paths.length !== 1) { reject('PATHWAY'); continue; }
          const path = paths[0]!;
          expectedDistance = Math.ceil(path.lengthMetres ?? expectedDistance);
          expectedSeconds = path.traversalSeconds ?? Math.ceil(expectedDistance / 1.25);
          if (leg.estimated !== (path.traversalSeconds === null)) reject('WALK_ESTIMATE');
        } else if (leg.verification === 'unverified') {
          if (!leg.estimated || leg.pathwayId !== undefined || leg.distanceMetres > 800) reject('WALK_ESTIMATE');
          const paths = source.shards.flatMap(shard => shard.pathways), nodes = new Set(paths.flatMap(path => [path.fromStopRef, path.toStopRef]));
          if (typeof leg.from === 'string' && typeof leg.to === 'string') {
            const station = (ref: TransitRef) => stop(ref)?.parentStationRef ?? ref;
            if (nodes.has(leg.from) && nodes.has(leg.to) || station(leg.from) === station(leg.to) && [...nodes].some(ref => station(ref) === station(leg.from as TransitRef))) reject('PATHWAY_BYPASS');
          } else {
            const ref = typeof leg.from === 'string' ? leg.from : typeof leg.to === 'string' ? leg.to : undefined;
            if (ref && nodes.has(ref) && stop(ref)?.locationType !== 2) reject('PATHWAY_BYPASS');
          }
        } else reject('WALK_VERIFICATION');
        if (leg.distanceMetres !== expectedDistance || arrive - depart !== expectedSeconds * 1000) reject('WALK_TIME_DISTANCE');
        continue;
      }
      if (leg.kind !== 'transit') { reject('LEG_KIND'); continue; }
      const matches = source.shards.flatMap(shard => shard.trips.filter(trip => trip.ref === leg.tripRef && leg.serviceDate >= shard.window.startDate && leg.serviceDate <= shard.window.endDate).map(trip => ({ shard, trip })));
      const found = matches[0];
      if (!found || matches.some(other => other.shard.source.sha256 !== found.shard.source.sha256)) { reject('TRIP_NOT_FOUND'); continue; }
      const { trip, shard } = found;
      const route = shard.routes.find(r => r.ref === trip.routeRef), calendar = shard.calendars[trip.serviceId];
      const canonicalSource = source.manifest.sources.find(s => s.feedId === shard.feedId);
      if (shard.coverageId !== itinerary.coverageId || !canonicalSource || shard.source.sha256 !== canonicalSource.sha256 || leg.scheduleVersion !== shard.source.sha256) reject('SCHEDULE_VERSION');
      if (!calendar || !isServiceActive(calendar, leg.serviceDate) || shard.source.feedInfo.some(info => info.feed_start_date && leg.serviceDate < info.feed_start_date || info.feed_end_date && leg.serviceDate > info.feed_end_date)) reject('SERVICE_DAY');
      if (!route || leg.routeRef !== trip.routeRef || leg.directionId !== trip.directionId) reject('ROUTE_DIRECTION');
      const board = trip.stopTimes.findIndex(call => call.sequence === leg.boardSequence), alight = trip.stopTimes.findIndex(call => call.sequence === leg.alightSequence);
      if (board < 0 || alight <= board) { reject('STOP_ORDER'); continue; }
      const boarding = trip.stopTimes[board]!, alighting = trip.stopTimes[alight]!, first = trip.stopTimes[0]!.departureSeconds;
      if (boarding.stopRef !== leg.from || alighting.stopRef !== leg.to) reject('STOP_IDENTITY');
      if (leg.headsign !== (boarding.headsign || trip.headsign)) reject('HEADSIGN');
      if (first == null || boarding.departureSeconds == null || alighting.arrivalSeconds == null || !route) { reject('UNTIMED_CALL'); continue; }
      const frequencies = shard.frequencies.filter(interval => interval.tripRef === trip.ref);
      if (!Number.isInteger(leg.instanceStartSeconds) || (frequencies.length ? !frequencies.some(interval => interval.exactTimes === 1 &&
        leg.instanceStartSeconds >= interval.startSeconds && leg.instanceStartSeconds < interval.endSeconds && (leg.instanceStartSeconds - interval.startSeconds) % interval.headwaySeconds === 0) : leg.instanceStartSeconds !== first)) reject('FREQUENCY_INSTANCE');
      const seconds = leg.instanceStartSeconds;
      const start = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      const identity = formatTripInstanceRef({ coverage: shard.coverageId, feed: shard.feedId, id: trip.providerId, serviceDate: leg.serviceDate, startTime: start });
      if (identity !== leg.tripInstanceRef) reject('TRIP_INSTANCE');
      const origin = serviceDayOrigin(leg.serviceDate, shard.agencyTimezones[route.agencyRef]!), shift = seconds - first;
      const scheduledDeparture = origin + (boarding.departureSeconds + shift) * 1000, scheduledArrival = origin + (alighting.arrivalSeconds + shift) * 1000;
      if (parseInstant(leg.scheduledDepartureTime) !== scheduledDeparture || parseInstant(leg.scheduledArrivalTime) !== scheduledArrival) reject('SCHEDULED_TIME');
      const tripRows = rows.filter(row => row.tripInstanceRef === identity);
      if (tripRows.some(row => row.status === 'canceled' || row.scheduleRelationship === 'CANCELED')) reject('TRIP_CANCELED');
      if (new Set(tripRows.map(row => row.stopSequence)).size !== tripRows.length) reject('REALTIME_AMBIGUOUS');
      const boardUpdate = tripRows.find(row => row.stopSequence === boarding.sequence), alightUpdate = tripRows.find(row => row.stopSequence === alighting.sequence);
      if ([boardUpdate, alightUpdate].some(row => row?.status === 'skipped' || row?.stopScheduleRelationship === 'SKIPPED')) reject('STOP_SKIPPED');
      for (const row of tripRows) {
        const call = trip.stopTimes.find(call => call.sequence === row.stopSequence);
        if (!call || row.stopId !== parseTransitRef(call.stopRef)?.id || row.tripId && row.tripId !== trip.providerId || row.serviceDate && row.serviceDate !== leg.serviceDate || row.routeId && row.routeId !== route.providerId) reject('REALTIME_IDENTITY');
        if (call && (row.scheduledArrivalTimeSeconds !== undefined && row.scheduledArrivalTimeSeconds * 1000 !== origin + (call.arrivalSeconds! + shift) * 1000 ||
          row.scheduledDepartureTimeSeconds !== undefined && row.scheduledDepartureTimeSeconds * 1000 !== origin + (call.departureSeconds! + shift) * 1000)) reject('REALTIME_SCHEDULE');
      }
      const departurePrediction = boardUpdate?.status === 'realtime' ? boardUpdate.departureTimeSeconds : undefined;
      const arrivalPrediction = alightUpdate?.status === 'realtime' ? alightUpdate.arrivalTimeSeconds : undefined;
      const predicted = departurePrediction !== undefined || arrivalPrediction !== undefined;
      if (depart !== (departurePrediction === undefined ? scheduledDeparture : departurePrediction * 1000) || arrive !== (arrivalPrediction === undefined ? scheduledArrival : arrivalPrediction * 1000)) reject('ADJUSTED_TIME');
      if (leg.status !== (predicted ? 'realtime' : 'scheduled_only') || (predicted ? leg.realtimeTimestampSeconds !== stamp : leg.realtimeTimestampSeconds !== undefined)) reject('REALTIME_PROVENANCE');
      realtime ||= predicted;
      let lastScheduled = -Infinity, lastAdjusted = -Infinity;
      for (const call of trip.stopTimes.slice(board, alight + 1)) {
        const row = tripRows.find(row => row.stopSequence === call.sequence);
        for (const [event, scheduled, adjusted] of [['arrival', call.arrivalSeconds, row?.status === 'realtime' ? row.arrivalTimeSeconds : undefined], ['departure', call.departureSeconds, row?.status === 'realtime' ? row.departureTimeSeconds : undefined]] as const) {
          if (scheduled === null) continue;
          if (call.sequence === boarding.sequence && event === 'arrival' || call.sequence === alighting.sequence && event === 'departure') continue;
          const schedule = origin + (scheduled + shift) * 1000, actual = adjusted === undefined ? schedule : adjusted * 1000;
          if (schedule < lastScheduled || actual < lastAdjusted || !Number.isFinite(actual)) reject('NONMONOTONIC_TRIP');
          lastScheduled = schedule; lastAdjusted = actual;
        }
      }
      const thisRide = { leg, trip, shard, board, alight };
      if (previousRide) {
        const prior = previousRide, matchesStop = (ref: TransitRef | undefined, actual: TransitRef) => !ref || ref === actual || ref === stop(actual)?.parentStationRef;
        const applicable = source.shards.flatMap(s => s.transfers).filter(rule => matchesStop(rule.fromStopRef, prior.leg.to) && matchesStop(rule.toStopRef, leg.from) &&
          (!rule.fromTripRef || rule.fromTripRef === prior.trip.ref) && (!rule.toTripRef || rule.toTripRef === trip.ref) &&
          (!rule.fromRouteRef || rule.fromRouteRef === prior.trip.routeRef) && (!rule.toRouteRef || rule.toRouteRef === trip.routeRef));
        // Independent selection: partition matches into trip/route specificity buckets.
        const buckets = new Map<number, typeof applicable>();
        for (const rule of applicable) {
          const rank = (rule.fromTripRef ? 4 : rule.fromRouteRef ? 1 : 0) + (rule.toTripRef ? 4 : rule.toRouteRef ? 1 : 0);
          buckets.set(rank, [...(buckets.get(rank) ?? []), rule]);
        }
        const rules = buckets.get([...buckets.keys()].sort((a, b) => b - a)[0]!) ?? [];
        if (rules.some(rule => rule.transferType === 3)) reject('TRANSFER_FORBIDDEN');
        if (rules.some(rule => depart - parseInstant(prior.leg.arrivalTime) < (rule.minTransferSeconds ?? 0) * 1000)) reject('TRANSFER_MINIMUM');
        const terminal = prior.alight === prior.trip.stopTimes.length - 1 && board === 0 && previous?.kind === 'transit';
        const linked = rules.some(rule => rule.transferType === 4);
        let sameBlock = trip.blockId !== '' && trip.blockId === prior.trip.blockId && shard.feedId === prior.shard.feedId && leg.serviceDate === prior.leg.serviceDate && prior.leg.to === leg.from;
        if (sameBlock) {
          const intervening = source.shards.filter(s => s.feedId === shard.feedId).flatMap(s => s.trips.filter(t => t.blockId === trip.blockId && t.ref !== prior.trip.ref && t.ref !== trip.ref &&
            isServiceActive(s.calendars[t.serviceId]!, leg.serviceDate))).some(t => {
            const starts = shard.frequencies.filter(f => f.tripRef === t.ref);
            if (!starts.length) return t.stopTimes[0]?.departureSeconds != null && t.stopTimes[0].departureSeconds >= prior.leg.instanceStartSeconds && t.stopTimes[0].departureSeconds <= leg.instanceStartSeconds;
            return starts.some(f => f.startSeconds < leg.instanceStartSeconds && f.endSeconds > prior.leg.instanceStartSeconds);
          });
          const conflictingLink = source.shards.flatMap(s => s.transfers).some(rule => rule.fromTripRef === prior.trip.ref && (rule.transferType === 4 || rule.transferType === 5) && rule.toTripRef !== trip.ref);
          sameBlock = !intervening && !conflictingLink;
        }
        const continuation = terminal && !rules.some(rule => rule.transferType === 5) && (linked || sameBlock);
        if (leg.continuation !== continuation) reject('CONTINUATION');
      } else if (leg.continuation) reject('CONTINUATION');
      if (!leg.continuation) changes++;
      if (boarding.pickupType !== 0 && !leg.continuation) reject('PICKUP');
      checked.push(thisRide); previousRide = thisRide;
    }
    checked.forEach((ride, index) => {
      if (ride.trip.stopTimes[ride.alight]!.dropOffType !== 0 && !checked[index + 1]?.leg.continuation) reject('DROPOFF');
    });
    if (!checked.length || changes !== itinerary.transfers || changes > itinerary.maxTransfers) reject('TRANSFER_COUNT');
    if (walked !== itinerary.walkingMetres || walked > itinerary.maxWalkMetres || walked > 800) reject('WALK_BUDGET');
    if (itinerary.status !== (realtime ? 'realtime' : 'scheduled_only')) reject('STATUS');
    if (itinerary.departureTime !== itinerary.legs[0]!.departureTime || itinerary.arrivalTime !== itinerary.legs.at(-1)!.arrivalTime) reject('SUMMARY_TIME');
  } catch (error) {
    abort();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    reject('MALFORMED_ITINERARY');
  }
  return { valid: reasons.size === 0, reasons: [...reasons] };
}
