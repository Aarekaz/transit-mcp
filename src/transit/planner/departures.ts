import { formatTripInstanceRef, parseTransitRef, type TransitRef, type TripInstanceRef } from '../core/refs';
import { loadScheduleWindow, type ScheduleWindow, type ScheduleWindowQuery } from './schedule-index';
import { formatInstant, isServiceActive, parseInstant } from './service-day';

export interface ScheduledDepartureQuery extends ScheduleWindowQuery {
  stopRef: TransitRef;
  routeRefs?: TransitRef[];
  selection?: 'first' | 'last';
  limit?: number;
}
export interface ScheduledDeparture {
  tripRef: TransitRef; tripInstanceRef: TripInstanceRef; serviceDate: string;
  routeRef: TransitRef; agencyRef: TransitRef; stopRef: TransitRef; stopSequence: number;
  headsign: string; directionId: number | null; pickupType: number;
  scheduledTime: string; predictedTime: null; status: 'scheduled_only';
  feedId: string; scheduleVersion: string; agencyTimezone: string;
}
export interface ScheduledDepartures extends Omit<ScheduleWindow, 'shards'> { departures: ScheduledDeparture[] }

function gtfsTime(seconds: number): string {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Schedule-only facts. Non-exact headway templates do not imply a precise departure. */
export async function getScheduledDepartures(query: ScheduledDepartureQuery): Promise<ScheduledDepartures> {
  const stop = parseTransitRef(query.stopRef);
  if (!stop || stop.kind !== 'stop' || stop.coverage !== query.manifest.coverageId || query.stopRef.split(':').length !== 5) throw new Error('INVALID_TRANSIT_REF: expected a stop reference in this coverage');
  for (const [refs, kind] of [[query.routeRefs, 'route'], [query.agencyRefs, 'agency']] as const) {
    for (const ref of refs ?? []) {
      const parsed = parseTransitRef(ref);
      if (!parsed || parsed.kind !== kind || parsed.coverage !== stop.coverage || ref.split(':').length !== 5) throw new Error('INVALID_TRANSIT_REF: invalid departure filter');
    }
  }
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid departure limit (1-100)');
  if (query.selection && query.selection !== 'first' && query.selection !== 'last') throw new Error('Invalid departure selection');
  const { shards, ...window } = await loadScheduleWindow({ ...query, feedIds: [stop.feed] });
  const departures: ScheduledDeparture[] = [];
  if (window.status === 'unavailable') return { ...window, departures };
  const start = parseInstant(query.instant), end = start + query.windowSeconds * 1000;
  const seen = new Set<string>();
  let foundStop = false;
  for (const { shard, serviceDays } of shards) {
    const requested = shard.stops.find(candidate => candidate.ref === query.stopRef);
    if (!requested) continue;
    foundStop = true;
    const stops = new Set(shard.stops.filter(candidate => candidate.ref === query.stopRef || candidate.parentStationRef === query.stopRef).map(candidate => candidate.ref));
    const routes = new Map(shard.routes.map(route => [route.ref, route]));
    const frequencies = new Map<TransitRef, typeof shard.frequencies>();
    for (const frequency of shard.frequencies) {
      const entries = frequencies.get(frequency.tripRef) ?? [];
      entries.push(frequency); frequencies.set(frequency.tripRef, entries);
    }
    for (const trip of shard.trips) {
      const route = routes.get(trip.routeRef)!;
      if (query.routeRefs && !query.routeRefs.includes(route.ref)) continue;
      if (query.agencyRefs && !query.agencyRefs.includes(route.agencyRef)) continue;
      const firstDeparture = trip.stopTimes[0]!.departureSeconds;
      if (firstDeparture === null) continue;
      for (const day of serviceDays) {
        if (day.agencyRef !== route.agencyRef || !isServiceActive(shard.calendars[trip.serviceId]!, day.serviceDate)) continue;
        const origin = parseInstant(day.startTime);
        for (const call of trip.stopTimes) {
          if (!stops.has(call.stopRef) || call.departureSeconds === null || call.pickupType === 1) continue;
          const append = (departureSeconds: number, instanceStart: number) => {
            const milliseconds = origin + departureSeconds * 1000;
            if (milliseconds < start || milliseconds >= end) return;
            const tripInstanceRef = formatTripInstanceRef({ coverage: stop.coverage, feed: shard.feedId, id: trip.providerId, serviceDate: day.serviceDate, startTime: gtfsTime(instanceStart) });
            const key = `${tripInstanceRef}:${call.sequence}`;
            if (seen.has(key)) return;
            seen.add(key);
            departures.push({ tripRef: trip.ref, tripInstanceRef, serviceDate: day.serviceDate, routeRef: route.ref, agencyRef: route.agencyRef,
              stopRef: call.stopRef, stopSequence: call.sequence, headsign: call.headsign || trip.headsign, directionId: trip.directionId,
              pickupType: call.pickupType, scheduledTime: formatInstant(milliseconds, day.timezone), predictedTime: null, status: 'scheduled_only',
              feedId: shard.feedId, scheduleVersion: shard.source.sha256, agencyTimezone: day.timezone });
          };
          const intervals = frequencies.get(trip.ref);
          if (!intervals) { append(call.departureSeconds, firstDeparture); continue; }
          const offset = call.departureSeconds - firstDeparture;
          for (const interval of intervals) {
            if (interval.exactTimes !== 1) continue;
            const firstIndex = Math.max(0, Math.ceil(((start - origin) / 1000 - offset - interval.startSeconds) / interval.headwaySeconds));
            const maximum = Math.min(interval.endSeconds, (end - origin) / 1000 - offset);
            for (let seconds = interval.startSeconds + firstIndex * interval.headwaySeconds; seconds < maximum; seconds += interval.headwaySeconds) append(seconds + offset, seconds);
          }
        }
      }
    }
  }
  if (!foundStop && !query.agencyRefs) throw new Error('ENTITY_NOT_FOUND: stop is absent from schedule');
  const direction = query.selection === 'last' ? -1 : 1;
  departures.sort((a, b) => direction * (Date.parse(a.scheduledTime) - Date.parse(b.scheduledTime)) || a.tripInstanceRef.localeCompare(b.tripInstanceRef) || a.stopSequence - b.stopSequence);
  return { ...window, departures: departures.slice(0, limit) };
}
