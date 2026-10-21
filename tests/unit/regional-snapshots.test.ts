import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { createRegionalTransitService } from '../../src/transit/gtfs/realtime/service';
import { RegionFeedHub } from '../../src/transit/gtfs/realtime/region-feed-hub';
import { getRealtimeSources } from '../../src/transit/gtfs/realtime/sources';
import { RealtimeSnapshotStore, StaticArtifactStore, SF511_QUOTA_NAMESPACE } from '../../src/transit/gtfs/realtime/snapshot-store';
import { memoryStorage, realtimeFixture } from '../helpers/realtime-fixture';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { decodeRealtimeFeed } from '../../src/transit/gtfs/realtime/decode';
import { applyTripUpdates } from '../../src/transit/gtfs/realtime/trip-match';
import { canonicalJson, sha256 } from '../../src/transit/gtfs/static/shards';

const NOW = Date.parse('2026-10-19T08:00:00-07:00') / 1000;
async function setup(fixture?: Awaited<ReturnType<typeof realtimeFixture>>) {
  const db = memoryStorage(), f = fixture ?? await realtimeFixture();
  db.objects.set(f.manifest.shards[0]!.key, f.shardBytes);
  db.objects.set(f.manifest.discoveries[0]!.key, f.discoveryBytes);
  const artifacts = new StaticArtifactStore(db.bucket), version = await artifacts.publish(f.manifest);
  const env = { TRANSIT_ARTIFACTS: db.bucket, SFBAY_MODE: 'dark', SF511_API_KEY: 'test-credential' } as Env;
  // Tests drive alarms directly: a reader is always present, so the coordinator keeps polling.
  await db.storage.put('readAt', Number.MAX_SAFE_INTEGER);
  const hub = new RegionFeedHub({ storage: db.storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, env);
  // Coordinators are addressed only by registered names; SF keeps its original one.
  const namespaces = getRealtimeSources().map(source => source.policy.namespace);
  expect(namespaces).toContain(SF511_QUOTA_NAMESPACE);
  env.REGION_FEED_HUB = { idFromName: (name: string) => { expect(namespaces).toContain(name); return { toString: () => name }; }, get: () => ({ fetch: (request: string | Request) => hub.fetch(typeof request === 'string' ? new Request(request) : request) }) } as unknown as DurableObjectNamespace;
  const store = new RealtimeSnapshotStore(db.storage);
  return { db, f, env, hub, store, version, artifacts, service: createRegionalTransitService(env) };
}

async function publishTrip(f: Awaited<ReturnType<typeof setup>>, ...tripUpdates: transit_realtime.ITripUpdate[]) {
  const bytes = transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW },
    entity: tripUpdates.map((tripUpdate, index) => ({ id: `e${index}`, tripUpdate })) }).finish();
  const applied = await applyTripUpdates(decodeRealtimeFeed(bytes), { manifest: f.f.manifest, shards: [f.f.shard], discoveries: [f.f.discovery], version: f.version, feedId: 'sf511' });
  await f.store.publish('trip_updates', { version: f.version, receivedAtSeconds: NOW, producerTimestampSeconds: NOW,
    payload: applied.stopUpdates, degraded: applied.degraded, warnings: applied.warnings });
  return applied;
}

describe('regional v2 snapshot service', () => {
  it('answers a cold stop read live from one provider request, then publishes the whole snapshot from it', async () => {
    const f = await setup(); vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const bytes = transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW },
      entity: [{ id: 'e', tripUpdate: { trip: { tripId: 'T', startDate: '20261019' }, stopTimeUpdate: [{ stopSequence: 1, arrival: { delay: 60 } }] } }] }).finish();
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => new URL((request as Request).url).pathname.endsWith('tripupdates') ? new Response(bytes) : new Response(null, { status: 503 }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await f.hub.fetch(new Request(`https://hub/trip_updates?now=${NOW}&artifact=${f.version.artifactVersion}&stop=S`));
      const read = await response.json<{ freshness: string; payload: { stopId: string; arrivalTimeSeconds: number }[] }>();
      expect(read.freshness).toBe('fresh');
      // The trip calls at S twice; the delay carries forward to the call the feed does not list.
      expect(read.payload.map(row => row.arrivalTimeSeconds)).toEqual([NOW + 60, NOW + 660]);
      // The whole snapshot is published from the same document, with the same rows for S.
      await vi.waitFor(async () => expect(await f.store.holds('trip_updates')).toBe(true));
      expect((await f.store.read('trip_updates', f.version, ['S']))?.payload).toEqual(read.payload);
      expect(upstream.mock.calls.filter(([request]) => new URL((request as Request).url).pathname.endsWith('tripupdates'))).toHaveLength(1);
    } finally { upstream.mockRestore(); warning.mockRestore(); vi.useRealTimers(); }
  });

  it('polls on read after a restart empties memory, but not within 30 s of the last attempt', async () => {
    const f = await setup(); vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const bytes = transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW }, entity: [] }).finish();
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes));
    const read = async (storage: DurableObjectStorage) => (await new RegionFeedHub({ storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, f.env)
      .fetch(new Request(`https://hub/trip_updates?now=${NOW}&artifact=${f.version.artifactVersion}`))).json<{ freshness: string }>();
    try {
      // The previous instance tried 10 s ago: an empty restart waits rather than hammer the provider.
      const recent = memoryStorage().storage; await recent.put('polled:trip_updates', NOW - 10);
      expect((await read(recent)).freshness).toBe('unavailable');
      expect(upstream).not.toHaveBeenCalled();
      // 40 s ago, inside the 120 s interval: it holds nothing, so it polls now.
      const older = memoryStorage().storage; await older.put('polled:trip_updates', NOW - 40);
      expect((await read(older)).freshness).toBe('fresh');
      expect(upstream).toHaveBeenCalled();
    } finally { upstream.mockRestore(); vi.useRealTimers(); }
  });

  it('sleeps while nobody reads, and a read wakes it and polls before answering', async () => {
    const f = await setup(); vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    await f.db.storage.delete('readAt');
    let alarm: number | null = null;
    vi.spyOn(f.db.storage, 'getAlarm').mockImplementation(async () => alarm);
    vi.spyOn(f.db.storage, 'setAlarm').mockImplementation(async value => { alarm = Number(value); });
    const bytes = transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW }, entity: [] }).finish();
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes));
    try {
      // Unread: the alarm polls nothing and schedules nothing.
      await f.hub.alarm();
      expect(upstream).not.toHaveBeenCalled();
      expect(alarm).toBeNull();
      // A read polls first, then keeps the coordinator polling.
      const read = await (await f.hub.fetch(new Request(`https://hub/trip_updates?now=${NOW}&artifact=${f.version.artifactVersion}`))).json<{ freshness: string }>();
      expect(read.freshness).toBe('fresh');
      expect(upstream).toHaveBeenCalled();
      expect(alarm).not.toBeNull();
      // Ten quiet minutes later it stops again.
      upstream.mockClear(); alarm = null;
      vi.setSystemTime((NOW + 601) * 1000);
      await f.hub.alarm();
      expect(upstream).not.toHaveBeenCalled();
      expect(alarm).toBeNull();
    } finally { upstream.mockRestore(); vi.useRealTimers(); }
  });

  it('schedules each feed by its attempt deadline so request duration cannot extend the cadence', async () => {
    const f = await setup(); vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    let nextAlarm = 0;
    const alarms = vi.spyOn(f.db.storage, 'setAlarm').mockImplementation(async value => { nextAlarm = Number(value); });
    const attempts: { path: string; time: number }[] = [];
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
      attempts.push({ path: new URL((request as Request).url).pathname, time: Date.now() });
      vi.setSystemTime(Date.now() + 1000);
      return new Response(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(Date.now() / 1000) }, entity: [] }).finish());
    });
    try {
      for (let cycle = 0; cycle < 8; cycle++) {
        await f.hub.alarm();
        expect(nextAlarm).toBeGreaterThan(Date.now());
        if (cycle === 0) expect(nextAlarm).toBe((NOW + 120) * 1000);
        vi.setSystemTime(nextAlarm);
      }
      const positions = attempts.filter(attempt => attempt.path.endsWith('vehiclepositions'));
      expect(positions.length).toBeGreaterThanOrEqual(2);
      expect(positions[1]!.time - positions[0]!.time).toBe(300000);
      const updates = attempts.filter(attempt => attempt.path.endsWith('tripupdates'));
      expect(updates[1]!.time - updates[0]!.time).toBe(120000);
    } finally { upstream.mockRestore(); alarms.mockRestore(); vi.useRealTimers(); }
  });
  it('advertises only observed absolute calls for an off-headway non-exact frequency instance', async () => {
    const f = await setup(await realtimeFixture('trip_id,start_time,end_time,headway_secs,exact_times\nT,08:00:00,10:00:00,600,0\n'));
    const applied = await publishTrip(f, {
      trip: { tripId: 'T', startDate: '20261019', startTime: '08:12:00', scheduleRelationship: 2 },
      stopTimeUpdate: [{ stopSequence: 1, arrival: { time: NOW + 780 } }], delay: 60,
    });
    expect(applied.degraded).toBe(false);
    expect(applied.stopUpdates[0]).toMatchObject({ status: 'realtime', arrivalTimeSeconds: NOW + 780 });
    expect(applied.stopUpdates[0]?.departureTimeSeconds).toBeUndefined();
    expect((await f.service.getStationPredictions('S', NOW)).payload).toEqual([
      expect.objectContaining({ tripId: 'T', stopSequence: 1, arrivalTimeSeconds: NOW + 780, status: 'realtime' }),
    ]);
    expect((await f.service.getStationPredictions('P', NOW)).payload).toEqual([]);
    expect((await f.service.getStationPredictions('Q', NOW)).payload).toEqual([]);
  });

  it('keeps duplicate and replacement schedules while suppressing template-only calls in a mixed snapshot', async () => {
    const f = await setup(await realtimeFixture('trip_id,start_time,end_time,headway_secs,exact_times\nT,08:00:00,10:00:00,600,0\n', {
      'trips.txt': 'route_id,service_id,trip_id\nR,D,T\nR,D,U\nR,D,V\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,S,1\nT,08:05:00,08:05:00,P,2\nU,08:00:00,08:00:00,S,1\nU,08:05:00,08:05:00,P,2\nV,08:00:00,08:00:00,S,1\nV,08:05:00,08:05:00,P,2\n',
    }));
    const applied = await publishTrip(f,
      { trip: { tripId: 'T', startDate: '20261019', startTime: '08:12:00', scheduleRelationship: 2 },
        stopTimeUpdate: [{ stopSequence: 1, arrival: { time: NOW + 780 } }] },
      { trip: { tripId: 'U', startDate: '20261019', scheduleRelationship: 6 },
        tripProperties: { tripId: 'copy', startDate: '20261019', startTime: '08:20:00' } },
      { trip: { tripId: 'V', startDate: '20261019', scheduleRelationship: 5 }, stopTimeUpdate: [
        { stopId: 'S', stopSequence: 1, scheduleRelationship: 2, arrival: { time: NOW + 1800 }, departure: { time: NOW + 1800 } },
        { stopId: 'P', stopSequence: 2, scheduleRelationship: 2, arrival: { time: NOW + 2100 }, departure: { time: NOW + 2100 } },
      ] },
    );
    expect(applied.degraded).toBe(false);
    expect((await f.service.getStationPredictions('S', NOW)).payload?.map(row => [row.tripId, row.arrivalTimeSeconds, row.status])).toEqual([
      ['U', NOW, 'scheduled_only'], ['T', NOW + 780, 'realtime'],
      ['copy', NOW + 1200, 'scheduled_only'], ['V', NOW + 1800, 'scheduled_only'],
    ]);
    expect((await f.service.getStationPredictions('P', NOW)).payload?.map(row => [row.tripId, row.arrivalTimeSeconds, row.status])).toEqual([
      ['U', NOW + 300, 'scheduled_only'], ['copy', NOW + 1500, 'scheduled_only'], ['V', NOW + 2100, 'scheduled_only'],
    ]);
  });

  it('rejects duplicate IDs owned by static trips outside the loaded window', async () => {
    const f = await setup(await realtimeFixture('', {
      'trips.txt': 'route_id,service_id,trip_id\nR,FUTURE,U\nR,D,T\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,S,1\nU,09:00:00,09:00:00,P,1\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nD,1,1,1,1,1,1,1,20260101,20261231\nFUTURE,1,1,1,1,1,1,1,20270101,20271231\n',
    }));
    expect(f.f.shard.trips.map(trip => trip.providerId)).toEqual(['T']);
    expect(f.f.shard.transferBoundaryTrips).toEqual([]);
    const applied = await publishTrip(f, { trip: { tripId: 'T', startDate: '20261019', scheduleRelationship: 6 },
      tripProperties: { tripId: 'U', startDate: '20261019', startTime: '08:00:00' }, delay: 120 });
    expect(applied.stopUpdates).toEqual([]);
    expect(applied.degraded).toBe(true);
    expect((await f.service.getStationPredictions('S', NOW)).payload).toEqual([
      expect.objectContaining({ tripId: 'T', arrivalTimeSeconds: NOW, status: 'scheduled_only' }),
    ]);
  });

  it.each([undefined, ['T', 'T'], ['U', 'T'], [42], ['']].map(tripProviderIds => ({ tripProviderIds })))('rejects malformed discovery trip identity indexes: %j', async ({ tripProviderIds }) => {
    const f = await setup();
    const bytes = new TextEncoder().encode(canonicalJson({ ...f.f.discovery, tripProviderIds }));
    const descriptor = { ...f.f.manifest.discoveries[0]!, sha256: await sha256(bytes), byteLength: bytes.length };
    f.db.objects.set(descriptor.key, bytes);
    await f.artifacts.publish({ ...f.f.manifest, discoveries: [descriptor] });
    await expect(f.service.getRoutes()).rejects.toThrow(/discovery/i);
  });

  it('returns a schedule-only duplicated trip alongside the unchanged original service', async () => {
    const f = await setup();
    const applied = await publishTrip(f, { trip: { tripId: 'T', startDate: '20261019', scheduleRelationship: 6 },
      tripProperties: { tripId: 'copy', startDate: '20261019', startTime: '08:02:00' } });
    expect(applied.degraded).toBe(false);
    const result = await f.service.getStationPredictions('S', NOW);
    expect(result.payload?.map(row => [row.tripId, row.arrivalTimeSeconds, row.status])).toEqual([
      ['T', NOW, 'scheduled_only'], ['copy', NOW + 120, 'scheduled_only'],
      ['T', NOW + 600, 'scheduled_only'], ['copy', NOW + 720, 'scheduled_only'],
    ]);
  });

  it('uses the complete NO_DATA replacement schedule with changed times and a new stop', async () => {
    const f = await setup(await realtimeFixture('', {
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nS,Station,37,-122\nP,Platform,37,-122\nQ,Last,37,-122\nX,New,37,-122\n',
    }));
    const applied = await publishTrip(f, { trip: { tripId: 'T', routeId: 'R', startDate: '20261019', scheduleRelationship: 5 },
      stopTimeUpdate: [
        { stopId: 'S', stopSequence: 1, scheduleRelationship: 2, arrival: { time: NOW + 120 }, departure: { time: NOW + 150 } },
        { stopId: 'X', stopSequence: 2, scheduleRelationship: 2, arrival: { time: NOW + 420 }, departure: { time: NOW + 450 } },
      ] });
    expect(applied.degraded).toBe(false);
    expect((await f.service.getStationPredictions('S', NOW)).payload).toEqual([
      expect.objectContaining({ tripId: 'T', arrivalTimeSeconds: NOW + 120, departureTimeSeconds: NOW + 150, status: 'scheduled_only' }),
    ]);
    expect((await f.service.getStationPredictions('X', NOW)).payload).toEqual([
      expect.objectContaining({ tripId: 'T', arrivalTimeSeconds: NOW + 420, departureTimeSeconds: NOW + 450, status: 'scheduled_only' }),
    ]);
    expect((await f.service.getStationPredictions('P', NOW)).payload).toEqual([]);
    expect((await f.service.getStationPredictions('Q', NOW)).payload).toEqual([]);
  });

  it.each([1, 5])('suppresses SKIPPED extra calls with supplied times for trip relationship %s', async scheduleRelationship => {
    const f = await setup();
    const applied = await publishTrip(f, { trip: { tripId: scheduleRelationship === 1 ? 'extra' : 'T', routeId: 'R', startDate: '20261019', scheduleRelationship },
      stopTimeUpdate: [{ stopId: 'P', stopSequence: 2, scheduleRelationship: 1, arrival: { time: NOW + 120 }, departure: { time: NOW + 150 } }] });
    expect(applied.stopUpdates.find(row => row.stopId === 'P')).toMatchObject({ status: 'skipped' });
    const result = await f.service.getStationPredictions('P', NOW);
    expect(result.payload?.map(row => [row.tripId, row.arrivalTimeSeconds])).toEqual(scheduleRelationship === 1 ? [['T', NOW + 300]] : []);
  });

  it('derives the route from the original dated trip for a route-less replacement', async () => {
    const f = await setup();
    const applied = await publishTrip(f, { trip: { tripId: 'T', startDate: '20261019', scheduleRelationship: 5 },
      stopTimeUpdate: [{ stopId: 'S', stopSequence: 1, arrival: { time: NOW + 120 }, departure: { time: NOW + 150 } }] });
    expect(applied.degraded).toBe(false);
    expect(applied.match).toEqual({ eligible: 0, matched: 0, rate: 1 });
    expect((await f.service.getStationPredictions('S', NOW)).payload).toEqual([
      expect.objectContaining({ tripId: 'T', routeId: 'R', arrivalTimeSeconds: NOW + 120, status: 'realtime' }),
    ]);
  });

  it('ignores malformed attached stop updates after matching a canceled trip', async () => {
    const f = await setup();
    const applied = await publishTrip(f, { trip: { tripId: 'T', startDate: '20261019', scheduleRelationship: 3 },
      stopTimeUpdate: [{ stopId: 'not-a-stop', stopSequence: 999, scheduleRelationship: 99 as transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship, arrival: { time: NOW + 120 } }] });
    expect(applied.match).toEqual({ eligible: 1, matched: 1, rate: 1 });
    expect(applied.stopUpdates).toHaveLength(4);
    expect(applied.stopUpdates.every(row => row.status === 'canceled')).toBe(true);
    expect((await f.service.getStationPredictions('S', NOW)).payload).toEqual([]);
    expect((await f.service.getStationPredictions('P', NOW)).payload).toEqual([]);
  });

  it.each([
    { tripId: 'T', startDate: '20261019', startTime: '08:00:00' },
    { tripId: 'T', startDate: '20261020', startTime: '09:00:00' },
    { tripId: 'U', startDate: '20261019', startTime: '08:00:00' },
  ])('rejects duplicated trip IDs colliding with static service: %j', async tripProperties => {
    const f = await setup(await realtimeFixture('', {
      'trips.txt': 'route_id,service_id,trip_id\nR,D,T\nR,D,U\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,S,1\nT,08:05:00,08:05:00,P,2\nU,08:00:00,08:00:00,S,1\nU,08:05:00,08:05:00,P,2\n',
    }));
    const applied = await publishTrip(f, { trip: { tripId: 'T', startDate: '20261019', scheduleRelationship: 6 }, tripProperties, delay: 120 });
    expect(applied.stopUpdates).toEqual([]);
    expect(applied.degraded).toBe(true);
    expect((await f.service.getStationPredictions('S', NOW)).payload?.map(row => [row.tripId, row.arrivalTimeSeconds, row.status])).toEqual([
      ['T', NOW, 'scheduled_only'], ['U', NOW, 'scheduled_only'],
    ]);
  });

  it('uses immutable discovery and exact static/realtime pins without fetching upstream while the coordinator is current', async () => {
    const f = await setup(); const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No request may fetch upstream'));
    try {
      // Polled moments ago: requests read what the coordinator holds.
      await f.db.storage.put('polled:trip_updates', Math.floor(Date.now() / 1000));
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

  it('verifies original discovery bytes before alarm normalization, not only reconstructed JSON', async () => {
    const f = await setup();
    const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(f.f.discovery).sort(([a], [b]) => a < b ? 1 : -1))));
    expect(bytes.length).toBe(f.f.discoveryBytes.length);
    expect(await sha256(bytes)).not.toBe(f.f.manifest.discoveries[0]!.sha256);
    f.db.objects.set(f.f.manifest.discoveries[0]!.key, bytes);
    const feed = transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW }, entity: [
      { id: 'e', tripUpdate: { trip: { tripId: 'T', startDate: '20261019' }, delay: 60 } },
    ] }).finish();
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(feed));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await f.hub.alarm();
      expect(await f.store.read('trip_updates', f.version)).toBeNull();
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
