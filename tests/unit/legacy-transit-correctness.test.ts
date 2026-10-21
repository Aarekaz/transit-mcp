import { createRequestStateCodec, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStationTools } from '../../src/mcp/tools/stations';
import { registerIncidentTools } from '../../src/mcp/tools/incidents';
import type { MetroRequestState } from '../../src/mcp/context';
import { WMATAClient } from '../../src/transit/wmata-client';
import { WMATAError, handleWMATAError } from '../../src/error-handler';
import { createMockEnv } from '../setup';
import { nycAlertFeed, nycFeed, nycRerouteFeed, redLinePath, redLineStations, REPLAY_NOW, wmataPath, wmataPredictions, wmataStations } from '../fixtures/legacy-transit';

function tools() {
  const registrations = new Map<string, { config: any; callback: (args: any, context: ServerContext) => Promise<any> }>();
  const server = { registerTool: (name: string, config: any, callback: any) => registrations.set(name, { config, callback }) } as unknown as McpServer;
  const context = { env: createMockEnv(), era: 'legacy' as const };
  registerStationTools(server, context, createRequestStateCodec<MetroRequestState>({ key: context.env.MCP_REQUEST_STATE_KEY, ttlSeconds: 300, bind: c => c.mcpReq.method }));
  registerIncidentTools(server, context);
  return async (name: string, args: any) => {
    const tool = registrations.get(name)!;
    const result = await tool.callback(args, { mcpReq: { signal: new AbortController().signal, requestState: () => undefined } } as unknown as ServerContext);
    if (result.structuredContent) expect(tool.config.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    return result;
  };
}

function protobuf(body: GtfsRealtimeBindings.transit_realtime.IFeedMessage = nycFeed) {
  return new Response(GtfsRealtimeBindings.transit_realtime.FeedMessage.encode(body).finish());
}

beforeEach(() => vi.useFakeTimers().setSystemTime(REPLAY_NOW));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('legacy provider correctness through real tool normalization', () => {
  it('preserves WMATA destination-bound direction and labels Group without inventing a physical track', async () => {
    vi.stubGlobal('fetch', async () => Response.json(wmataPredictions));
    const result = await tools()('get_station_predictions', { city: 'dc', stationName: 'A03' });
    expect(result.structuredContent.predictions).toMatchObject([
      { destination: 'Shady Grove', direction: 'Shady Grove-bound', track: 'Group 1', arrivalStatus: 'ARRIVING', minutesAway: 2 },
      { destination: 'Glenmont', direction: 'Glenmont-bound', track: 'Group 2', arrivalStatus: 'ARRIVING', minutesAway: 5 },
    ]);
  });

  it('retains both sides of the Metro Center complex without fabricated walking time', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ Stations: wmataStations }));
    const stations = await new WMATAClient('test').getStations();
    expect(stations.find(s => s.id === 'A01')).toMatchObject({ stationTogether: ['C01'], lines: ['RD'] });
    expect(stations.find(s => s.id === 'C01')).toMatchObject({ stationTogether: ['A01'], lines: ['BL', 'OR', 'SV'] });
  });

  it('orders Red Line evidence toward Glenmont: Dupont precedes Metro Center, the reverse is Shady Grove-bound', async () => {
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/jStations')) return Response.json({ Stations: redLineStations });
      if (url.pathname.endsWith('/jLines')) return Response.json({ Lines: [{ LineCode: 'RD', DisplayName: 'Red', StartStationCode: 'A15', EndStationCode: 'B11', InternalDestination1: 'A11', InternalDestination2: 'B08' }] });
      if (url.pathname.endsWith('/jPath') && url.searchParams.get('FromStationCode') === 'A15' && url.searchParams.get('ToStationCode') === 'B11') return Response.json(redLinePath);
      return new Response(null, { status: 404 });
    });
    const result = await tools()('get_stations_by_line', { city: 'dc', lineCode: 'RD' });
    const ordered = result.structuredContent.stations.map((s: any) => s.id);
    expect(ordered[0]).toBe('A15');
    expect(ordered.at(-1)).toBe('B11');
    expect(ordered.slice(12, 15)).toEqual(['A03', 'A02', 'A01']);
  });

  it('rejects an incomplete WMATA path rather than presenting it as the line', async () => {
    vi.stubGlobal('fetch', async (input: string) => {
      if (input.endsWith('/jStations')) return Response.json({ Stations: redLineStations });
      if (input.endsWith('/jLines')) return Response.json({ Lines: [{ LineCode: 'RD', StartStationCode: 'A15', EndStationCode: 'B11' }] });
      return Response.json(wmataPath);
    });
    await expect(tools()('get_stations_by_line', { city: 'dc', lineCode: 'RD' })).rejects.toThrow('WMATA ordered line path unavailable');
  });

  it.each([{}, { Path: null }, { Path: [null] }])('returns the same safe failure for malformed ordered WMATA paths %j', async path => {
    vi.stubGlobal('fetch', async (input: string) => {
      if (input.endsWith('/jStations')) return Response.json({ Stations: redLineStations });
      if (input.endsWith('/jLines')) return Response.json({ Lines: [{ LineCode: 'RD', StartStationCode: 'A15', EndStationCode: 'B11' }] });
      return Response.json(path);
    });
    await expect(tools()('get_stations_by_line', { city: 'dc', lineCode: 'RD' })).rejects.toThrow('WMATA ordered line path unavailable');
  });

  it('retains a present past-due NYC call as delayed and excludes the actually departed trip', async () => {
    vi.stubGlobal('fetch', async (input: string) => input.endsWith('nyct%2Fgtfs') ? protobuf() : protobuf({ ...nycFeed, entity: [] }));
    const result = await tools()('get_station_predictions', { city: 'nyc', stationName: '137S' });
    expect(result.structuredContent.predictions).toEqual([
      { line: '1', destination: 'South Ferry', minutesAway: 0, arrivalTime: '2026-10-18T15:59:30.000Z', arrivalStatus: 'DELAYED', cars: null, direction: 'SOUTH', track: null },
      { line: '1', destination: 'South Ferry', minutesAway: null, arrivalTime: '2026-10-18T15:59:50.000Z', arrivalStatus: 'BOARDING', cars: null, direction: 'SOUTH', track: null },
      { line: '1', destination: 'South Ferry', minutesAway: 5, arrivalTime: '2026-10-18T16:05:00.000Z', arrivalStatus: 'ARRIVING', cars: null, direction: 'SOUTH', track: null },
    ]);
  });

  it('returns a stable error when one relevant Coney Island feed fails instead of a quiet station', async () => {
    vi.stubGlobal('fetch', async (input: string) => input.endsWith('nyct%2Fgtfs-nqrw')
      ? new Response('secret upstream incident body', { status: 503, statusText: 'secret status text' })
      : protobuf({ ...nycFeed, entity: [] }));
    await expect(tools()('get_station_predictions', { city: 'nyc', stationName: 'D43' })).rejects.toThrow('MTA predictions unavailable: a required feed could not be loaded');
  });

  it('fails closed when a failed feed could contain rerouted station service', async () => {
    vi.stubGlobal('fetch', async (input: string) => input.endsWith('nyct%2Fgtfs')
      ? protobuf() : new Response('not proven unrelated', { status: 503 }));
    await expect(tools()('get_station_predictions', { city: 'nyc', stationName: '137S' })).rejects.toThrow('MTA predictions unavailable: a required feed could not be loaded');
  });

  it('includes an F train rerouted to A27 even though the station snapshot lists only A/C/E', async () => {
    vi.stubGlobal('fetch', async (input: string) => input.endsWith('nyct%2Fgtfs-bdfm')
      ? protobuf(nycRerouteFeed) : protobuf({ ...nycFeed, entity: [] }));
    const result = await tools()('get_station_predictions', { city: 'nyc', stationName: 'A27S' });
    expect(result.structuredContent.predictions).toEqual([
      { line: 'F', destination: 'Coney Island-Stillwell Av', minutesAway: 5, arrivalTime: '2026-10-18T16:05:00.000Z', arrivalStatus: 'ARRIVING', cars: null, direction: 'SOUTH', track: null },
    ]);
  });

  it('does not call A27 quiet when the feed carrying its rerouted F train fails', async () => {
    vi.stubGlobal('fetch', async (input: string) => input.endsWith('nyct%2Fgtfs-bdfm')
      ? new Response('secret response body', { status: 503, statusText: 'secret status' })
      : protobuf({ ...nycFeed, entity: [] }));
    await expect(tools()('get_station_predictions', { city: 'nyc', stationName: 'A27S' })).rejects.toThrow('Error: MTA predictions unavailable: a required feed could not be loaded');
  });

  it.each([
    ['arrival only', { arrival: { time: 1792339500 } }, '2026-10-18T16:05:00.000Z'],
    ['departure only', { departure: { time: 1792339500 } }, '2026-10-18T16:05:00.000Z'],
    ['empty arrival with valid departure', { arrival: {}, departure: { time: 1792339500 } }, '2026-10-18T16:05:00.000Z'],
    ['valid arrival with empty departure', { arrival: { time: 1792339500 }, departure: {} }, '2026-10-18T16:05:00.000Z'],
    ['both missing', {}, null],
    ['both empty', { arrival: {}, departure: {} }, null],
  ] as const)('uses timestamp presence rather than protobuf defaults: %s', async (_label, events, expectedTime) => {
    vi.stubGlobal('fetch', async (input: string) => input.endsWith('nyct%2Fgtfs')
      ? protobuf({
        header: { gtfsRealtimeVersion: '1.0', timestamp: 1792339200 },
        entity: [{ id: 'timestamp-presence', tripUpdate: {
          trip: { tripId: '070500_1..S03R', routeId: '1', startDate: '20261018' },
          stopTimeUpdate: [{ stopId: '137S', ...events }, { stopId: '142S', arrival: { time: 1792340500 } }],
        } }],
      }) : protobuf({ ...nycFeed, entity: [] }));
    const result = await tools()('get_station_predictions', { city: 'nyc', stationName: '137S' });
    expect(result.structuredContent.predictions).toEqual(expectedTime === null ? [] : [
      { line: '1', destination: 'South Ferry', minutesAway: 5, arrivalTime: expectedTime, arrivalStatus: 'ARRIVING', cars: null, direction: 'SOUTH', track: null },
    ]);
  });

  it.each([
    ['902', 'GS', '901N', 'gtfs', 'Grand Central-42 St'],
    ['S03', 'FS', 'D26S', 'gtfs-bdfm', 'Prospect Park'],
    ['H12', 'H', 'H15S', 'gtfs-ace', 'Rockaway Park-Beach 116 St'],
    ['725', '7', '701N', 'gtfs', 'Flushing-Main St'],
    ['635', '6', '601N', 'gtfs', 'Pelham Bay Park'],
  ])('uses the authoritative route feed for %s without losing shuttle or numbered service', async (stationId, routeId, terminal, feed, destination) => {
    const stopId = `${stationId}${terminal.endsWith('N') ? 'N' : 'S'}`;
    vi.stubGlobal('fetch', async (input: string) => input.endsWith(`nyct%2F${feed}`)
      ? new Response(GtfsRealtimeBindings.transit_realtime.FeedMessage.encode({
        header: { gtfsRealtimeVersion: '1.0', timestamp: 1792339200 },
        entity: [{ id: 'route-feed', tripUpdate: {
          trip: { tripId: '070500_route', routeId, startDate: '20261018' },
          stopTimeUpdate: [{ stopId, arrival: { time: 1792339500 } }, { stopId: terminal, arrival: { time: 1792340500 } }],
        } }],
      }).finish())
      : protobuf({ ...nycFeed, entity: [] }));
    const result = await tools()('get_station_predictions', { city: 'nyc', stationName: stationId });
    expect(result.structuredContent.predictions).toMatchObject([{ line: routeId, destination, minutesAway: 5 }]);
  });

  it('does not invent an arrival when a stop update has no timestamp', async () => {
    vi.stubGlobal('fetch', async () => new Response(GtfsRealtimeBindings.transit_realtime.FeedMessage.encode({
      header: { gtfsRealtimeVersion: '1.0', timestamp: 1792339200 },
      entity: [{ id: 'missing-time', tripUpdate: {
        trip: { tripId: '070500_1..S03R', routeId: '1', startDate: '20261018' },
        stopTimeUpdate: [{ stopId: '137S' }, { stopId: '142S', arrival: { time: 1792340500 } }],
      } }],
    }).finish()));
    expect((await tools()('get_station_predictions', { city: 'nyc', stationName: '137S' })).structuredContent.predictions).toEqual([]);
  });

  it('keeps a missing alert update timestamp explicitly unknown', async () => {
    vi.stubGlobal('fetch', async () => Response.json(nycAlertFeed));
    const result = await tools()('get_incidents', { city: 'nyc' });
    expect(result.structuredContent.incidents[0].lastUpdated).toBe('Unknown');
  });

  it('does not turn an alerts feed outage into no incidents', async () => {
    vi.stubGlobal('fetch', async () => new Response('secret upstream', { status: 503 }));
    await expect(tools()('get_incidents', { city: 'nyc' })).rejects.toThrow('MTA service alerts unavailable');
  });

  it('keeps WMATA upstream bodies out of tool errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('secret upstream', { status: 503 }));
    await expect(tools()('get_station_predictions', { city: 'dc', stationName: 'A03' })).rejects.toThrow('Transit API Error [DC] (503): WMATA API request failed. The agency\'s service is failing right now');
  });
});

describe('agency errors', () => {
  it('tell the caller what to do, not just the agency\'s status code', () => {
    expect(handleWMATAError(new WMATAError('WMATA API request failed', 400))).toMatch(/did not recognise that ID.*find_transit/);
    expect(handleWMATAError(new WMATAError('WMATA API request failed', 404))).toMatch(/did not recognise/);
    expect(handleWMATAError(new WMATAError('WMATA API request failed', 429))).toMatch(/try again in a minute/);
    expect(handleWMATAError(new WMATAError('WMATA API request failed', 401))).toMatch(/nothing the caller can change/);
    expect(handleWMATAError(new WMATAError('WMATA API request failed', 502))).toMatch(/failing right now/);
  });
});
