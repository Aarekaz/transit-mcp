import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { Env } from '../../src/types';
import { createRegionalTransitService } from '../../src/transit/gtfs/realtime/service';

function envWithArtifact(generatedAt = new Date().toISOString()): Env {
  const artifact = {
    schemaVersion: 1, region: 'sfbay', sourceVersion: 'fixture', generatedAt,
    stops: [
      { id: 'P1', name: 'Market Platform', latitude: 37.7, longitude: -122.4, locationType: 0, parentStationId: 'S1' },
      { id: 'S1', name: 'Market Street', latitude: 37.7, longitude: -122.4, locationType: 1 },
    ],
    routes: [{ id: 'R1', shortName: 'N', longName: 'Judah', mode: 'tram' }],
    stopRoutes: { P1: ['R1'], S1: ['R1'] },
    stopTimes: [{ tripId: 'T1', routeId: 'R1', serviceId: 'WK', stopId: 'P1', arrivalSeconds: 29100, departureSeconds: 29100 }],
    calendars: { WK: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true, startDate: '20260101', endDate: '20261231', exceptions: {} } },
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
    TRANSIT_ARTIFACTS: {
      get: async (key: string) => {
        expect(key).toBe('artifacts/sfbay/current.json.gz');
        return { body: new Response(gzipSync(JSON.stringify(artifact))).body };
      },
    } as unknown as R2Bucket,
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
    const expired = createRegionalTransitService(envWithArtifact('2020-01-01T00:00:00.000Z'));
    await expect(expired.getRoutes()).rejects.toThrow('artifact is expired');
  });

  it('falls back to scheduled future arrivals when realtime is unavailable', async () => {
    const env = envWithArtifact();
    const stub = env.REGION_FEED_HUB!.get(env.REGION_FEED_HUB!.idFromName('sfbay')) as unknown as { fetch: (request: Request | string) => Promise<Response> };
    stub.fetch = async () => Response.json({ freshness: 'unavailable', warnings: ['unavailable_feed'], payload: null });
    const service = createRegionalTransitService(env);
    const mondayEightAmPacific = Date.parse('2026-10-19T15:00:00Z') / 1000;
    const result = await service.getStationPredictions('S1', mondayEightAmPacific);
    expect(result.payload).toEqual([expect.objectContaining({ routeId: 'R1', arrivalTimeSeconds: mondayEightAmPacific + 300 })]);
    expect(result.warnings).toContain('scheduled_fallback');
  });
});
