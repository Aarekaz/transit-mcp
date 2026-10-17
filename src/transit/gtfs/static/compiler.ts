import { parseGtfsCsv, type GtfsCsvRow } from './csv';
import { createStaticArtifact, type ArtifactRoute, type ArtifactStop, type StaticTransitArtifact } from './artifact';
import { routeTypeToMode } from './modes';
import { parseGtfsTime } from './time';
import type { ServiceCalendar } from './artifact';

export type GtfsStaticFiles = Record<'stops.txt' | 'routes.txt' | 'trips.txt' | 'stop_times.txt', string> & Partial<Record<'calendar.txt' | 'calendar_dates.txt', string>>;

function required(row: GtfsCsvRow, name: string): string {
  const value = row[name];
  if (!value) throw new Error(`Missing required GTFS field: ${name}`);
  return value;
}

function finiteNumber(row: GtfsCsvRow, name: string): number {
  const value = Number(required(row, name));
  if (!Number.isFinite(value)) throw new Error(`Invalid GTFS number: ${name}`);
  return value;
}

export function compileGtfsStatic(
  files: GtfsStaticFiles,
  metadata: { sourceVersion: string; generatedAt: string },
): StaticTransitArtifact {
  const stopRows = parseGtfsCsv(files['stops.txt']);
  const routeRows = parseGtfsCsv(files['routes.txt']);
  const tripRows = parseGtfsCsv(files['trips.txt']);
  const stopTimeRows = parseGtfsCsv(files['stop_times.txt']);

  const stops: ArtifactStop[] = stopRows
    .filter(row => row.location_type !== '3')
    .map(row => ({
    id: required(row, 'stop_id'),
    name: required(row, 'stop_name'),
    latitude: finiteNumber(row, 'stop_lat'),
    longitude: finiteNumber(row, 'stop_lon'),
    locationType: row.location_type ? finiteNumber(row, 'location_type') : 0,
    ...(row.parent_station ? { parentStationId: row.parent_station } : {}),
    }));
  const routes: ArtifactRoute[] = routeRows.map(row => ({
    id: required(row, 'route_id'),
    shortName: row.route_short_name ?? '',
    longName: row.route_long_name ?? '',
    mode: routeTypeToMode(finiteNumber(row, 'route_type')),
    ...(row.route_color ? { color: row.route_color } : {}),
  }));
  const trips = new Map(tripRows.map(row => [required(row, 'trip_id'), { routeId: required(row, 'route_id'), serviceId: required(row, 'service_id') }]));
  const parentByStop = new Map(stops.map(stop => [stop.id, stop.parentStationId]));
  const stopRoutes: Record<string, string[]> = {};

  for (const row of stopTimeRows) {
    const trip = trips.get(required(row, 'trip_id'));
    if (!trip) throw new Error('stop_times.txt references an unknown trip_id');
    const stopId = required(row, 'stop_id');
    (stopRoutes[stopId] ??= []).push(trip.routeId);
    const parentId = parentByStop.get(stopId);
    if (parentId) (stopRoutes[parentId] ??= []).push(trip.routeId);
  }

  const calendars: Record<string, ServiceCalendar> = {};
  for (const row of files['calendar.txt'] ? parseGtfsCsv(files['calendar.txt']) : []) {
    const serviceId = required(row, 'service_id');
    calendars[serviceId] = {
      monday: row.monday === '1', tuesday: row.tuesday === '1', wednesday: row.wednesday === '1', thursday: row.thursday === '1',
      friday: row.friday === '1', saturday: row.saturday === '1', sunday: row.sunday === '1',
      startDate: required(row, 'start_date'), endDate: required(row, 'end_date'), exceptions: {},
    };
  }
  for (const row of files['calendar_dates.txt'] ? parseGtfsCsv(files['calendar_dates.txt']) : []) {
    const serviceId = required(row, 'service_id');
    const calendar = calendars[serviceId] ??= { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false, startDate: '00000000', endDate: '99999999', exceptions: {} };
    calendar.exceptions[required(row, 'date')] = finiteNumber(row, 'exception_type') as 1 | 2;
  }
  const stopTimes = stopTimeRows
    .filter(row => row.arrival_time && row.departure_time)
    .map(row => {
    const tripId = required(row, 'trip_id');
    const trip = trips.get(tripId)!;
    return { tripId, routeId: trip.routeId, serviceId: trip.serviceId, stopId: required(row, 'stop_id'), arrivalSeconds: parseGtfsTime(required(row, 'arrival_time')).totalSeconds, departureSeconds: parseGtfsTime(required(row, 'departure_time')).totalSeconds };
    });

  return createStaticArtifact({
    region: 'sfbay',
    sourceVersion: metadata.sourceVersion,
    generatedAt: metadata.generatedAt,
    stops,
    routes,
    stopRoutes,
    stopTimes,
    calendars,
  });
}
