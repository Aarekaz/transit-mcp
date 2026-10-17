import { parseGtfsCsv, type GtfsCsvRow } from './csv';
import { createStaticArtifact, type ArtifactRoute, type ArtifactStop, type StaticTransitArtifact } from './artifact';
import { routeTypeToMode } from './modes';

export type GtfsStaticFiles = Record<'stops.txt' | 'routes.txt' | 'trips.txt' | 'stop_times.txt', string>;

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

  const stops: ArtifactStop[] = stopRows.map(row => ({
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
  const tripRoutes = new Map(tripRows.map(row => [required(row, 'trip_id'), required(row, 'route_id')]));
  const parentByStop = new Map(stops.map(stop => [stop.id, stop.parentStationId]));
  const stopRoutes: Record<string, string[]> = {};

  for (const row of stopTimeRows) {
    const routeId = tripRoutes.get(required(row, 'trip_id'));
    if (!routeId) throw new Error('stop_times.txt references an unknown trip_id');
    const stopId = required(row, 'stop_id');
    (stopRoutes[stopId] ??= []).push(routeId);
    const parentId = parentByStop.get(stopId);
    if (parentId) (stopRoutes[parentId] ??= []).push(routeId);
  }

  return createStaticArtifact({
    region: 'sfbay',
    sourceVersion: metadata.sourceVersion,
    generatedAt: metadata.generatedAt,
    stops,
    routes,
    stopRoutes,
  });
}
