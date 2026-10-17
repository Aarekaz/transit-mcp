import { describe, expect, it } from 'vitest';
import { parseGtfsCsv } from '../../src/transit/gtfs/static/csv';
import { parseGtfsTime } from '../../src/transit/gtfs/static/time';
import { encodeTransitId, transitResourceUri } from '../../src/regions/ids';
import { routeTypeToMode } from '../../src/transit/gtfs/static/modes';
import { createStaticArtifact, searchStops } from '../../src/transit/gtfs/static/artifact';
import { compileGtfsStatic } from '../../src/transit/gtfs/static/compiler';

describe('GTFS static primitives', () => {
  it('parses RFC 4180 rows with BOM, CRLF, commas, quotes, and newlines', () => {
    const csv = '\uFEFFstop_id,stop_name,desc\r\nA,"Market, Street","Line 1\r\nLine 2"\r\nB,"He said ""go""",\r\n';
    expect(parseGtfsCsv(csv)).toEqual([
      { stop_id: 'A', stop_name: 'Market, Street', desc: 'Line 1\r\nLine 2' },
      { stop_id: 'B', stop_name: 'He said "go"', desc: '' },
    ]);
  });

  it('rejects duplicate headers and rows with the wrong width', () => {
    expect(() => parseGtfsCsv('id,id\n1,2\n')).toThrow('Duplicate GTFS header');
    expect(() => parseGtfsCsv('id,name\n1\n')).toThrow('columns');
  });

  it('parses service times past midnight without normalizing them away', () => {
    expect(parseGtfsTime('00:00:00')).toEqual({ hours: 0, minutes: 0, seconds: 0, totalSeconds: 0 });
    expect(parseGtfsTime('25:30:05')).toEqual({ hours: 25, minutes: 30, seconds: 5, totalSeconds: 91805 });
    expect(() => parseGtfsTime('12:60:00')).toThrow('Invalid GTFS time');
  });

  it('preserves case-sensitive ids and percent-encodes resource segments', () => {
    expect(encodeTransitId('Ab:c /%')).toBe('Ab:c /%');
    expect(transitResourceUri('sfbay', 'stops', 'Ab:c /%')).toBe('transit://stops/sfbay/Ab%3Ac%20%2F%25');
  });

  it('maps standard and extended route types and rejects unknown values', () => {
    expect(routeTypeToMode(0)).toBe('tram');
    expect(routeTypeToMode(1)).toBe('subway');
    expect(routeTypeToMode(2)).toBe('rail');
    expect(routeTypeToMode(3)).toBe('bus');
    expect(routeTypeToMode(4)).toBe('ferry');
    expect(routeTypeToMode(5)).toBe('cable_tram');
    expect(routeTypeToMode(11)).toBe('trolleybus');
    expect(routeTypeToMode(100)).toBe('rail');
    expect(() => routeTypeToMode(99)).toThrow('Unsupported GTFS route_type');
  });

  it('builds byte-stable regional indexes and searches parent stations first', () => {
    const artifact = createStaticArtifact({
      region: 'sfbay',
      sourceVersion: 'fixture-v1',
      generatedAt: '2026-10-17T00:00:00.000Z',
      stops: [
        { id: 'platform-b', name: 'Montgomery B', latitude: 37.79, longitude: -122.4, parentStationId: 'station-1', locationType: 0 },
        { id: 'station-1', name: 'Montgomery Street', latitude: 37.79, longitude: -122.4, locationType: 1 },
        { id: 'platform-a', name: 'Montgomery A', latitude: 37.79, longitude: -122.4, parentStationId: 'station-1', locationType: 0 },
      ],
      routes: [{ id: 'route-z', shortName: 'N', longName: 'Judah', mode: 'tram', color: '0039A6' }],
      stopRoutes: { 'station-1': ['route-z', 'route-z'] },
    });

    expect(artifact.stops.map(stop => stop.id)).toEqual(['platform-a', 'platform-b', 'station-1']);
    expect(artifact.stopRoutes['station-1']).toEqual(['route-z']);
    expect(searchStops(artifact, 'montgomery', 2).map(stop => stop.id)).toEqual(['station-1', 'platform-a']);
    expect(JSON.stringify(artifact)).toBe(JSON.stringify(createStaticArtifact({
      region: 'sfbay', sourceVersion: 'fixture-v1', generatedAt: '2026-10-17T00:00:00.000Z',
      stops: [...artifact.stops].reverse(), routes: artifact.routes, stopRoutes: artifact.stopRoutes,
    })));
  });

  it('compiles the minimum GTFS tables into a deterministic query artifact', () => {
    const artifact = compileGtfsStatic({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,Market,37.7,-122.4,1,\nP1,Market Platform,37.7,-122.4,0,S1\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type,route_color\nR1,N,Judah,0,0039A6\n',
      'trips.txt': 'route_id,service_id,trip_id\nR1,WK,T1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,25:00:00,25:00:30,P1,1\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261001,20261031\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nWK,20261019,1\n',
    }, { sourceVersion: 'sha256:fixture', generatedAt: '2026-10-17T00:00:00.000Z' });

    expect(artifact.routes[0]).toMatchObject({ id: 'R1', mode: 'tram' });
    expect(artifact.stopRoutes).toEqual({ P1: ['R1'], S1: ['R1'] });
    expect(artifact.stopTimes).toEqual([expect.objectContaining({ tripId: 'T1', serviceId: 'WK', arrivalSeconds: 90000 })]);
    expect(artifact.calendars!.WK).toMatchObject({ monday: true, startDate: '20261001' });
  });

  it('ignores unnamed GTFS pathway nodes that are not transit stops', () => {
    const artifact = compileGtfsStatic({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,Market,37.7,-122.4,1,\nP1,Market Platform,37.7,-122.4,0,S1\nN1,,37.7,-122.4,3,S1\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR1,N,Judah,0\n',
      'trips.txt': 'route_id,service_id,trip_id\nR1,WK,T1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,12:00:00,12:00:30,P1,1\n',
    }, { sourceVersion: 'sha256:pathways', generatedAt: '2026-10-17T00:00:00.000Z' });

    expect(artifact.stops.map(stop => stop.id)).toEqual(['P1', 'S1']);
  });

  it('keeps route associations but omits untimed stop-time rows from scheduled arrivals', () => {
    const artifact = compileGtfsStatic({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,Market,37.7,-122.4,1,\nP1,Market Platform,37.7,-122.4,0,S1\nP2,Church Platform,37.8,-122.4,0,\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR1,N,Judah,0\n',
      'trips.txt': 'route_id,service_id,trip_id\nR1,WK,T1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,,,P1,1\nT1,12:05:00,12:05:30,P2,2\n',
    }, { sourceVersion: 'sha256:untimed', generatedAt: '2026-10-17T00:00:00.000Z' });

    expect(artifact.stopRoutes).toEqual({ P1: ['R1'], P2: ['R1'], S1: ['R1'] });
    expect(artifact.stopTimes).toEqual([
      expect.objectContaining({ stopId: 'P2', arrivalSeconds: 43500, departureSeconds: 43530 }),
    ]);
  });
});
