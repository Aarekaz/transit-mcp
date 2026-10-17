import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/types';
import { createRegionalTransitService } from '../../src/transit/gtfs/realtime/service';

function envWithArtifact(): Env {
  const artifact = {
    schemaVersion: 1, region: 'sfbay', sourceVersion: 'fixture', generatedAt: '2026-10-17T00:00:00.000Z',
    stops: [
      { id: 'P1', name: 'Market Platform', latitude: 37.7, longitude: -122.4, locationType: 0, parentStationId: 'S1' },
      { id: 'S1', name: 'Market Street', latitude: 37.7, longitude: -122.4, locationType: 1 },
    ],
    routes: [{ id: 'R1', shortName: 'N', longName: 'Judah', mode: 'tram' }],
    stopRoutes: { P1: ['R1'], S1: ['R1'] },
  };
  const stub = {
    fetch: async (request: Request | string) => {
      const path = new URL(typeof request === 'string' ? request : request.url).pathname;
      const payload = path === '/trip_updates'
        ? [{ entityId: 'u1', stopId: 'P1', routeId: 'R1', arrivalTimeSeconds: 1060 }]
        : path === '/service_alerts'
          ? [{ id: 'a1', header: 'Delay', description: 'Wait', routeIds: ['R1'], stopIds: [] }]
          : [];
      return Response.json({ freshness: 'fresh', producerTimestampSeconds: 1000, receivedAtSeconds: 1001, warnings: [], payload });
    },
  };
  return {
    TRANSIT_ARTIFACTS: { get: async () => ({ json: async () => artifact }) } as unknown as R2Bucket,
    REGION_FEED_HUB: { idFromName: () => ({}), get: () => stub } as unknown as DurableObjectNamespace,
  } as Env;
}

describe('regional transit service', () => {
  it('reads static data from R2 and expands parent-station arrival queries', async () => {
    const service = createRegionalTransitService(envWithArtifact());
    expect(await service.searchStations('market')).toEqual([
      expect.objectContaining({ id: 'S1', routeIds: ['R1'] }),
      expect.objectContaining({ id: 'P1', routeIds: ['R1'] }),
    ]);
    expect(await service.getRoutes()).toEqual([expect.objectContaining({ id: 'R1' })]);
    expect((await service.getStationPredictions('S1', 1000)).payload).toEqual([
      expect.objectContaining({ stopId: 'P1' }),
    ]);
    expect((await service.getAlerts(1000)).payload).toEqual([
      expect.objectContaining({ id: 'a1' }),
    ]);
  });

  it('fails closed when the artifact is absent or invalid', async () => {
    const missing = createRegionalTransitService({ REGION_FEED_HUB: envWithArtifact().REGION_FEED_HUB } as Env);
    await expect(missing.getRoutes()).rejects.toThrow('artifact is not configured');
  });
});
