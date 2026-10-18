import type { NormalizedAlertSelector } from './decode';
import { parseTransitRef, type ParsedTransitRef } from '../../core/refs';
import type { LoadedScheduleShard } from '../../planner/schedule-index';
import { isServiceActive, parseInstant } from '../../planner/service-day';
import { matchTripInstance, type TripMatchContext } from './trip-match';

const MAX_ALERT_SCOPES = 10_000;
export class AlertScopeLimitError extends Error {}

/** One authoritative route or dated ride, never fields pooled across rides. */
export interface AlertScope {
  feedId: string;
  agencyId?: string; routeId?: string; routeType?: number; directionId?: number | null;
  stopIds: Set<string>;
  tripId?: string; serviceDate?: string; startTime?: string; frequency?: boolean;
}

export function matchesAlertSelector(selector: NormalizedAlertSelector, scope: AlertScope): boolean {
  for (const key of ['agencyId', 'routeId', 'routeType', 'directionId'] as const) {
    if (selector[key] !== undefined && selector[key] !== scope[key]) return false;
  }
  if (selector.stopId !== undefined && !scope.stopIds.has(selector.stopId)) return false;
  const trip = selector.trip;
  if (!trip) return true;
  if (!scope.tripId || (!trip.tripId && !(trip.routeId && trip.directionId !== undefined && trip.startTime && trip.startDate))) return false;
  if (scope.frequency && !(trip.tripId && trip.startDate && trip.startTime)) return false;
  return (trip.tripId === undefined || trip.tripId === scope.tripId) &&
    (trip.routeId === undefined || trip.routeId === scope.routeId) &&
    (trip.directionId === undefined || trip.directionId === scope.directionId) &&
    (trip.startDate === undefined || trip.startDate === scope.serviceDate) &&
    (trip.startTime === undefined || trip.startTime === scope.startTime);
}

/** Resolve a complete ID-less descriptor independently of the requested scope.
 * A narrow query must not hide a second canonical trip with the same identity. */
export function resolveAlertSelector(selector: NormalizedAlertSelector, context: TripMatchContext): NormalizedAlertSelector | null {
  const trip = selector.trip;
  if (!trip || trip.tripId !== undefined) return selector;
  if (!(trip.routeId && trip.directionId !== undefined && trip.startTime && trip.startDate)) return null;
  const matches = new Map<string, string>(), seen = new Set<string>();
  for (const shard of context.shards) {
    if (shard.feedId !== context.feedId || trip.startDate < shard.window.startDate || trip.startDate > shard.window.endDate) continue;
    for (const candidate of shard.trips) {
      if (candidate.directionId !== trip.directionId || parseTransitRef(candidate.routeRef)?.id !== trip.routeId || seen.has(candidate.ref)) continue;
      if (seen.size >= MAX_ALERT_SCOPES) throw new AlertScopeLimitError('Alert identity budget exceeded');
      seen.add(candidate.ref);
      const match = matchTripInstance({ entityId: 'alert-identity', tripId: candidate.providerId, routeId: trip.routeId,
        startDate: trip.startDate, startTime: trip.startTime, scheduleRelationship: 'SCHEDULED', rawScheduleRelationship: 0, stops: [] }, { ...context, shards: [shard] });
      if (match) matches.set(match.tripInstanceRef, candidate.providerId);
      if (matches.size > 1) return null;
    }
  }
  return matches.size === 1 ? { ...selector, trip: { ...trip, tripId: [...matches.values()][0]! } } : null;
}

/** Canonical dated subentities for an aggregate query's explicit bounded window. */
export function expandAlertScopes(loaded: LoadedScheduleShard[], target: ParsedTransitRef, start: number, end: number): AlertScope[] {
  const scopes: AlertScope[] = [], seen = new Set<string>();
  for (const { shard, serviceDays } of loaded) {
    if (shard.feedId !== target.feed) continue;
    const requestedStops = new Set(shard.stops.filter(stop => parseTransitRef(stop.ref)?.id === target.id || parseTransitRef(stop.parentStationRef ?? '')?.id === target.id).map(stop => stop.ref));
    const routes = new Map(shard.routes.map(route => [route.ref, route]));
    for (const trip of shard.trips) {
      const route = routes.get(trip.routeRef)!;
      if (target.kind === 'route' && route.providerId !== target.id || target.kind === 'agency' && parseTransitRef(route.agencyRef)?.id !== target.id) continue;
      if (target.kind === 'stop' && !trip.stopTimes.some(call => requestedStops.has(call.stopRef))) continue;
      const first = trip.stopTimes[0]?.departureSeconds;
      if (first == null) continue;
      const last = trip.stopTimes.reduce((maximum, call) => Math.max(maximum, call.arrivalSeconds ?? 0, call.departureSeconds ?? 0), first);
      const frequencies = shard.frequencies.filter(row => row.tripRef === trip.ref);
      for (const day of serviceDays) {
        if (day.agencyRef !== route.agencyRef || !isServiceActive(shard.calendars[trip.serviceId]!, day.serviceDate)) continue;
        const origin = parseInstant(day.startTime);
        const append = (seconds: number, latestSeconds = seconds, exact = true) => {
          const shift = seconds - first, latestShift = latestSeconds - first;
          if (origin + seconds * 1000 >= end || origin + (last + latestShift) * 1000 < start) return;
          const calls = trip.stopTimes.filter(call => target.kind !== 'stop' || requestedStops.has(call.stopRef) &&
            origin + ((call.departureSeconds ?? call.arrivalSeconds ?? -Infinity) + latestShift) * 1000 >= start &&
            origin + ((call.departureSeconds ?? call.arrivalSeconds ?? Infinity) + shift) * 1000 < end);
          if (!calls.length) return;
          const identity = JSON.stringify([trip.ref, day.serviceDate, seconds, latestSeconds, exact]);
          if (seen.has(identity)) return;
          if (scopes.length >= MAX_ALERT_SCOPES) throw new AlertScopeLimitError('Alert scope budget exceeded');
          seen.add(identity);
          scopes.push({ feedId: shard.feedId, agencyId: parseTransitRef(route.agencyRef)!.id, routeId: route.providerId, routeType: route.routeType,
            directionId: trip.directionId, tripId: trip.providerId, serviceDate: day.serviceDate, frequency: frequencies.length > 0,
            startTime: exact ? `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : undefined,
            stopIds: new Set(calls.map(call => parseTransitRef(call.stopRef)!.id)) });
        };
        if (!frequencies.length) { append(first); continue; }
        for (const frequency of frequencies) {
          // A headway template proves its route/direction/stops, not an exact instance.
          if (frequency.exactTimes !== 1) { append(frequency.startSeconds, frequency.endSeconds - 1, false); continue; }
          const earliest = Math.max(frequency.startSeconds, (start - origin) / 1000 - (last - first));
          const offset = Math.max(0, Math.ceil((earliest - frequency.startSeconds) / frequency.headwaySeconds));
          const maximum = Math.min(frequency.endSeconds, (end - origin) / 1000);
          for (let seconds = frequency.startSeconds + offset * frequency.headwaySeconds; seconds < maximum; seconds += frequency.headwaySeconds) append(seconds);
        }
      }
    }
  }
  return scopes;
}
