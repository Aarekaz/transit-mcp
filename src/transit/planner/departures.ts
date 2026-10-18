import { formatTripInstanceRef, parseTransitRef, type TransitRef, type TripInstanceRef } from '../core/refs';
import { loadScheduleWindow, type ScheduleWindow, type ScheduleWindowQuery } from './schedule-index';
import { formatInstant, isServiceActive, parseInstant } from './service-day';
import { sha256 } from '../gtfs/static/shards';
import { z } from 'zod';

export interface ScheduledDepartureQuery extends ScheduleWindowQuery {
  stopRef: TransitRef;
  /** Reads the manifest-pinned discovery object independently of timetable filters. */
  readDiscovery: (key: string) => Promise<Uint8Array>;
  routeRefs?: TransitRef[];
  selection?: 'first' | 'last';
  /** Limits exact departures only. All overlapping frequency windows are returned, up to 100. */
  limit?: number;
}
export interface ScheduledDeparture {
  tripRef: TransitRef; tripInstanceRef: TripInstanceRef; serviceDate: string;
  routeRef: TransitRef; agencyRef: TransitRef; stopRef: TransitRef; stopSequence: number;
  headsign: string; directionId: number | null; pickupType: number;
  scheduledTime: string; predictedTime: null; status: 'scheduled_only';
  feedId: string; scheduleVersion: string; agencyTimezone: string;
}
export interface ScheduledFrequencyWindow extends Omit<ScheduledDeparture, 'tripInstanceRef' | 'scheduledTime' | 'predictedTime'> {
  /** Identifies the dated frequency template, never an observed or precisely scheduled trip instance. */
  tripTemplateRef: TripInstanceRef;
  /** Full stop-offset service interval [startTime, endTime); boundaries are not departure promises. */
  startTime: string; endTime: string;
  overlapStartTime: string; overlapEndTime: string;
  headwaySeconds: number; exactTimes: false;
}
export interface ScheduledDepartures extends Omit<ScheduleWindow, 'shards'> {
  departures: ScheduledDeparture[];
  /** Chronological headway windows, unaffected by first/last selection of exact departures. */
  frequencyWindows: ScheduledFrequencyWindow[];
}
const MAX_FREQUENCY_WINDOWS = 100;
const discoveryIdentitySchema = z.object({
  schemaVersion: z.literal(2), coverageId: z.string(), feedId: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stops: z.array(z.object({ ref: z.string() })),
});

async function assertKnownStop(query: ScheduledDepartureQuery, feedId: string): Promise<void> {
  if (!Array.isArray(query.manifest.discoveries)) throw new Error('Discovery identity invalid');
  const descriptors = query.manifest.discoveries.filter(descriptor => descriptor.feedId === feedId);
  if (descriptors.length !== 1) throw new Error('Discovery identity missing or ambiguous');
  const descriptor = descriptors[0]!;
  if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1 || descriptor.byteLength > 64 * 1024 * 1024) throw new Error('Discovery byte budget exceeded');
  const bytes = await query.readDiscovery(descriptor.key);
  if (bytes.byteLength !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Discovery integrity failure');
  let discovery;
  try { discovery = discoveryIdentitySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))); }
  catch { throw new Error('Discovery identity invalid'); }
  const sources = query.manifest.sources.filter(source => source.feedId === feedId);
  if (discovery.coverageId !== query.manifest.coverageId || discovery.feedId !== feedId || sources.length !== 1 || discovery.sourceSha256 !== sources[0]!.sha256) throw new Error('Discovery identity mismatch');
  const refs = new Set<string>();
  for (const stop of discovery.stops) {
    const ref = parseTransitRef(stop.ref);
    if (!ref || ref.kind !== 'stop' || ref.feed !== feedId || ref.coverage !== discovery.coverageId || refs.has(stop.ref)) throw new Error('Discovery identity mismatch');
    refs.add(stop.ref);
  }
  if (!refs.has(query.stopRef)) throw new Error('ENTITY_NOT_FOUND: stop is absent from discovery');
}

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
  await assertKnownStop(query, stop.feed);
  const { shards, ...window } = await loadScheduleWindow({ ...query, feedIds: [stop.feed] });
  const departures: ScheduledDeparture[] = [];
  const frequencyWindows: ScheduledFrequencyWindow[] = [];
  if (window.status === 'unavailable') return { ...window, departures, frequencyWindows };
  const start = parseInstant(query.instant), end = start + query.windowSeconds * 1000;
  const seen = new Set<string>();
  const seenWindows = new Set<string>();
  for (const { shard, serviceDays } of shards) {
    const requested = shard.stops.find(candidate => candidate.ref === query.stopRef);
    if (!requested) continue;
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
            if (interval.exactTimes !== 1) {
              const begins = origin + (interval.startSeconds + offset) * 1000;
              const ends = origin + (interval.endSeconds + offset) * 1000;
              if (begins >= end || ends <= start) continue;
              const tripTemplateRef = formatTripInstanceRef({ coverage: stop.coverage, feed: shard.feedId, id: trip.providerId,
                serviceDate: day.serviceDate, startTime: gtfsTime(interval.startSeconds) });
              const key = `${tripTemplateRef}:${call.sequence}:${interval.endSeconds}:${interval.headwaySeconds}`;
              if (seenWindows.has(key)) continue;
              if (frequencyWindows.length >= MAX_FREQUENCY_WINDOWS) throw new Error('TIME_OUTSIDE_WINDOW: more than 100 frequency windows; narrow the search window or filters');
              seenWindows.add(key);
              frequencyWindows.push({ tripRef: trip.ref, tripTemplateRef, serviceDate: day.serviceDate, routeRef: route.ref, agencyRef: route.agencyRef,
                stopRef: call.stopRef, stopSequence: call.sequence, headsign: call.headsign || trip.headsign, directionId: trip.directionId,
                pickupType: call.pickupType, startTime: formatInstant(begins, day.timezone), endTime: formatInstant(ends, day.timezone),
                overlapStartTime: formatInstant(Math.max(start, begins), day.timezone), overlapEndTime: formatInstant(Math.min(end, ends), day.timezone),
                headwaySeconds: interval.headwaySeconds, exactTimes: false, status: 'scheduled_only', feedId: shard.feedId,
                scheduleVersion: shard.source.sha256, agencyTimezone: day.timezone });
              continue;
            }
            const firstIndex = Math.max(0, Math.ceil(((start - origin) / 1000 - offset - interval.startSeconds) / interval.headwaySeconds));
            const maximum = Math.min(interval.endSeconds, (end - origin) / 1000 - offset);
            for (let seconds = interval.startSeconds + firstIndex * interval.headwaySeconds; seconds < maximum; seconds += interval.headwaySeconds) append(seconds + offset, seconds);
          }
        }
      }
    }
  }
  const direction = query.selection === 'last' ? -1 : 1;
  departures.sort((a, b) => direction * (Date.parse(a.scheduledTime) - Date.parse(b.scheduledTime)) || a.tripInstanceRef.localeCompare(b.tripInstanceRef) || a.stopSequence - b.stopSequence);
  frequencyWindows.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.tripTemplateRef.localeCompare(b.tripTemplateRef) ||
    a.stopSequence - b.stopSequence || Date.parse(a.endTime) - Date.parse(b.endTime) || a.headwaySeconds - b.headwaySeconds);
  return { ...window, departures: departures.slice(0, limit), frequencyWindows };
}
