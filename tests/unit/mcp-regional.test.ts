import { describe, expect, it } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import { createMetroMcpServer } from '../../src/mcp/server';
import { createMockEnv } from '../setup';

describe('Bay Area MCP rollout', () => {
  it('is absent by default and registers an attributed vehicle tool only when on', async () => {
    const darkServer = createMetroMcpServer({ env: createMockEnv(), era: 'modern' });
    const darkTools = (darkServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(darkTools.get_vehicle_positions).toBeUndefined();

    const env = { ...createMockEnv(), SFBAY_MODE: 'on' as const };
    const server = createMetroMcpServer({
      env,
      era: 'modern',
      deps: {
        regionalTransitService: {
          searchStations: async (_query, limit = 20) => Array.from({ length: limit }, (_, index) => ({
            id: index === 0 ? 'S1' : `S${index + 1}`, name: 'Montgomery Street', latitude: 37.789, longitude: -122.401,
            locationType: 1, routeIds: ['BART'],
          })),
          getStationPredictions: async () => ({
            freshness: 'fresh', producerTimestampSeconds: 1_000, receivedAtSeconds: 1_001,
            warnings: [], payload: [{ entityId: 'u1', stopId: 'S1', routeId: 'BART', tripId: 'T1', arrivalTimeSeconds: Math.floor(Date.now() / 1_000) + 60 }],
          }),
          getRoutes: async () => [{ id: 'BART', shortName: 'Yellow', longName: 'Antioch–SFO', mode: 'rail' }],
          getAlerts: async () => ({
            freshness: 'stale', producerTimestampSeconds: 900, receivedAtSeconds: 901,
            warnings: ['stale_feed'], payload: [{ id: 'a1', header: 'Delay', description: 'Expect delays', routeIds: ['BART'], stopIds: [] }],
          }),
          getVehiclePositions: async () => ({
            freshness: 'fresh',
            producerTimestampSeconds: 1_000,
            receivedAtSeconds: 1_001,
            warnings: [],
            payload: [
              { entityId: 'entity-1', vehicleId: 'vehicle-1', routeId: 'BART', latitude: 37.77, longitude: -122.42 },
              { entityId: 'entity-2', vehicleId: 'vehicle-2', routeId: 'MUNI', latitude: 37.78, longitude: -122.41 },
            ],
          }),
        },
      },
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<unknown> }> })._registeredTools;
    const result = await tools.get_vehicle_positions!.handler(
      { city: 'sfbay', routeId: 'BART', limit: 1 },
      { mcpReq: { signal: new AbortController().signal } } as ServerContext,
    ) as { structuredContent: Record<string, unknown> };

    expect(result.structuredContent).toMatchObject({
      city: 'sfbay', freshness: 'fresh',
      attribution: { text: expect.stringContaining('511 SF Bay') },
      vehicles: [{ id: 'vehicle-1' }],
    });
    expect((result.structuredContent.vehicles as unknown[])).toHaveLength(1);

    expect(Object.keys(tools)).toEqual(expect.arrayContaining([
      'search_sfbay_stations',
      'get_sfbay_station_predictions',
      'get_sfbay_routes',
      'get_sfbay_incidents',
      'get_vehicle_positions',
    ]));

    const search = await tools.search_sfbay_stations!.handler(
      { query: 'montgomery', limit: 25 },
      { mcpReq: { signal: new AbortController().signal } } as ServerContext,
    ) as { structuredContent: Record<string, unknown> };
    expect(search.structuredContent).toMatchObject({ city: 'sfbay', attribution: { text: expect.stringContaining('511 SF Bay') } });
    expect((search.structuredContent.results as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'S1', routes: ['BART'] });
    expect((search.structuredContent.results as unknown[])).toHaveLength(25);

    const predictions = await tools.get_sfbay_station_predictions!.handler(
      { stationId: 'S1' },
      { mcpReq: { signal: new AbortController().signal } } as ServerContext,
    ) as { structuredContent: Record<string, unknown> };
    expect(predictions.structuredContent).toMatchObject({
      stationId: 'S1', freshness: 'fresh', predictions: [{ routeId: 'BART', minutesAway: 1 }],
    });

    const routes = await tools.get_sfbay_routes!.handler(
      {}, { mcpReq: { signal: new AbortController().signal } } as ServerContext,
    ) as { structuredContent: Record<string, unknown> };
    expect(routes.structuredContent).toMatchObject({ routes: [{ id: 'BART', mode: 'rail' }] });

    const incidents = await tools.get_sfbay_incidents!.handler(
      {}, { mcpReq: { signal: new AbortController().signal } } as ServerContext,
    ) as { structuredContent: Record<string, unknown> };
    expect(incidents.structuredContent).toMatchObject({
      freshness: 'stale', warnings: ['stale_feed'], incidents: [{ id: 'a1', title: 'Delay' }],
    });
  });
});
