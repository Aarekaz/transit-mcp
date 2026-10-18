import type { NormalizedAlertSelector } from './decode';

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
  if (!scope.tripId || (!trip.tripId && !(trip.routeId && trip.directionId !== undefined && trip.startTime))) return false;
  if (scope.frequency && !(trip.tripId && trip.startDate && trip.startTime)) return false;
  return (trip.tripId === undefined || trip.tripId === scope.tripId) &&
    (trip.routeId === undefined || trip.routeId === scope.routeId) &&
    (trip.directionId === undefined || trip.directionId === scope.directionId) &&
    (trip.startDate === undefined || trip.startDate === scope.serviceDate) &&
    (trip.startTime === undefined || trip.startTime === scope.startTime);
}
