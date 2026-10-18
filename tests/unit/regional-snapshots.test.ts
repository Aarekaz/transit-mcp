import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { createRegionalTransitService } from '../../src/transit/gtfs/realtime/service';
import { RegionFeedHub } from '../../src/transit/gtfs/realtime/region-feed-hub';
import { RealtimeSnapshotStore, StaticArtifactStore, SF511_QUOTA_NAMESPACE } from '../../src/transit/gtfs/realtime/snapshot-store';
import { memoryStorage, realtimeFixture } from '../helpers/realtime-fixture';
import { transit_realtime } from 'gtfs-realtime-bindings';

const NOW = Date.parse('2026-10-19T08:00:00-07:00') / 1000;
async function setup() {
  const db = memoryStorage(), f = await realtimeFixture();
  db.objects.set(f.manifest.shards[0]!.key, f.shardBytes);
  db.objects.set(f.manifest.discoveries[0]!.key, f.discoveryBytes);
  const artifacts = new StaticArtifactStore(db.bucket), version = await artifacts.publish(f.manifest);
  const env = { TRANSIT_ARTIFACTS: db.bucket, SFBAY_MODE: 'dark', SF511_API_KEY: 'test-credential' } as Env;
  const hub = new RegionFeedHub({ storage: db.storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, env);
  env.REGION_FEED_HUB = { idFromName: (name: string) => { expect(name).toBe(SF511_QUOTA_NAMESPACE); return {}; }, get: () => ({ fetch: (request: string | Request) => hub.fetch(typeof request === 'string' ? new Request(request) : request) }) } as unknown as DurableObjectNamespace;
  const store = new RealtimeSnapshotStore(db.storage, db.bucket);
  return { db, f, env, hub, store, version, artifacts, service: createRegionalTransitService(env) };
}

describe('regional v2 snapshot service', () => {
  it('uses immutable discovery and exact static/realtime pins without fetching upstream during requests', async () => {
    const f = await setup(); const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No request may fetch upstream'));
    try {
      await f.store.publish('trip_updates', { version: f.version, receivedAtSeconds: NOW, producerTimestampSeconds: NOW,
        payload: [{ entityId: 'e', tripId: 'T', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDg6MDA6MDA', stopSequence: 1, stopId: 'S', routeId: 'R', status: 'realtime', arrivalTimeSeconds: NOW + 60, departureTimeSeconds: NOW + 60 }] });
      expect(await f.service.searchStations('Station')).toEqual([expect.objectContaining({ id: 'S', routeIds: ['R'] })]);
      expect(await f.service.getRoutes()).toEqual([expect.objectContaining({ id: 'R' })]);
      expect(await f.service.getStationPredictions('S', NOW)).toMatchObject({ status: 'realtime', version: f.version, payload: [expect.objectContaining({ arrivalTimeSeconds: NOW + 60 }), expect.objectContaining({ arrivalTimeSeconds: NOW + 600, status: 'scheduled_only' })] });
      expect(upstream).not.toHaveBeenCalled();
    } finally { upstream.mockRestore(); }
  });

  it('uses the current schedule when snapshots refer to a previous static version without loading that previous artifact', async () => {
    const f = await setup();
    await f.store.publish('trip_updates', { version: f.version, receivedAtSeconds: NOW, producerTimestampSeconds: NOW,
      payload: [{ entityId: 'old', stopId: 'S', arrivalTimeSeconds: NOW + 999 }] });
    const current = await f.artifacts.publish({ ...f.f.manifest, validator: { name: 'MobilityData GTFS Validator', version: '2', reportSha256: 'a'.repeat(64), systemErrorsSha256: 'b'.repeat(64), systemErrorsFormat: 'MobilityData notices', validatedAt: '2026-10-19' } });
    f.db.reads.length = 0;
    const result = await f.service.getStationPredictions('S', NOW);
    expect(result).toMatchObject({ status: 'scheduled_only', warnings: expect.arrayContaining(['SCHEDULE_REALTIME_MISMATCH']) });
    expect(result.payload?.[0]?.arrivalTimeSeconds).toBe(NOW);
    expect(result.version).toEqual(current);
    expect(f.db.reads).not.toContain(`artifacts/sfbay/v2/manifests/${f.version.artifactVersion}.json`);
  });

  it.each([181, 600, 601])('returns scheduled-only departures at Trip Updates age %s', async age => {
    const f = await setup();
    await f.store.publish('trip_updates', { version: f.version, receivedAtSeconds: NOW, producerTimestampSeconds: NOW - age,
      payload: [{ entityId: 'old', stopId: 'S', arrivalTimeSeconds: NOW + 999 }] });
    const result = await f.service.getStationPredictions('S', NOW);
    expect(result.status).toBe('scheduled_only');
    expect(result.payload?.[0]?.arrivalTimeSeconds).toBe(NOW);
    expect(result.ageSeconds).toBe(age);
  });

  it('keeps cancellation and skipped calls suppressed when a fresh snapshot has no remaining predictions', async () => {
    const f = await setup();
    await f.store.publish('trip_updates', { version: f.version, receivedAtSeconds: NOW, producerTimestampSeconds: NOW,
      payload: [1, 3].map(stopSequence => ({ entityId: 'c', tripId: 'T', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDg6MDA6MDA', stopSequence, stopId: 'S', status: 'canceled' })) });
    expect((await f.service.getStationPredictions('S', NOW)).payload).toEqual([]);
  });

  it('degrades low static-match snapshots even when their producer timestamp is fresh', async () => {
    const f = await setup();
    await f.store.publish('trip_updates', { version: f.version, receivedAtSeconds: NOW, producerTimestampSeconds: NOW, degraded: true,
      warnings: ['SCHEDULE_REALTIME_MISMATCH'], payload: [{ entityId: 'unmatched', stopId: 'S', arrivalTimeSeconds: NOW + 999 }] });
    expect(await f.service.getStationPredictions('S', NOW)).toMatchObject({ status: 'scheduled_only', warnings: expect.arrayContaining(['SCHEDULE_REALTIME_MISMATCH']) });
  });

  it('rejects a mutated discovery object and missing storage', async () => {
    const f = await setup();
    f.db.objects.set(f.f.manifest.discoveries[0]!.key, new TextEncoder().encode('{}'));
    await expect(f.service.getRoutes()).rejects.toThrow(/integrity/i);
    const missing = createRegionalTransitService({} as Env);
    await expect(missing.getRoutes()).rejects.toThrow(/not configured/i);
  });

  it('polls only from alarms, consumes quota on failure and writes normalized payloads only to R2', async () => {
    const f = await setup();
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const bytes = transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW }, entity: [{ id: 'e', tripUpdate: { trip: { tripId: 'T', startDate: '20261019' }, stopTimeUpdate: [{ stopSequence: 1, arrival: { delay: 60 } }] } }] }).finish();
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => new URL((request as Request).url).pathname.endsWith('tripupdates') ? new Response(bytes) : new Response(null, { status: 503 }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await f.hub.alarm();
      const read = await f.store.read<{ arrivalTimeSeconds: number }>('trip_updates', f.version, ['S']);
      expect(read?.payload?.[0]?.arrivalTimeSeconds).toBe(NOW + 60);
      expect(f.db.values.get('quota:sfbay:511')).toHaveLength(3);
      expect(JSON.stringify([...f.db.values])).not.toContain('test-credential');
      expect(JSON.stringify([...f.db.values])).not.toContain('arrivalTimeSeconds');
    } finally { upstream.mockRestore(); warning.mockRestore(); vi.useRealTimers(); }
  });

  it('retires an old differently-named hub so two objects cannot spend independent budgets for the same credential', async () => {
    const f = await setup();
    const oldDb = memoryStorage();
    const old = new RegionFeedHub({ id: { toString: () => 'old-sfbay-id' }, storage: oldDb.storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, f.env);
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await old.alarm(); expect(upstream).not.toHaveBeenCalled(); }
    finally { upstream.mockRestore(); warning.mockRestore(); }
  });
});
