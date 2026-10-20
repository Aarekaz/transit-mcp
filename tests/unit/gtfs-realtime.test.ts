import { describe, expect, it } from 'vitest';
import { classifyFreshness, sanitizeTransitText } from '../../src/transit/gtfs/realtime/freshness';
import { allocatePollIntervals } from '../../src/transit/gtfs/upstream/budget';
import { buildUpstreamRequest, redactUpstreamUrl } from '../../src/transit/gtfs/upstream/request';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { decodeRealtimeFeed } from '../../src/transit/gtfs/realtime/decode';
import { RegionalFeedHubCore } from '../../src/transit/gtfs/realtime/hub-core';
import { pollAttemptState, safePollFailureReason } from '../../src/transit/gtfs/realtime/region-feed-hub';
import * as matching from '../../src/transit/gtfs/realtime/trip-match';
import * as snapshots from '../../src/transit/gtfs/realtime/snapshot-store';
import { SFBAY_COVERAGE } from '../../src/regions/sfbay';
import { memoryStorage, realtimeFixture } from '../helpers/realtime-fixture';

const START = Date.parse('2026-10-19T08:00:00-07:00') / 1000;
function decodedTrip(trip: transit_realtime.ITripDescriptor = {}, stops: transit_realtime.TripUpdate.IStopTimeUpdate[] = [], extra: Partial<transit_realtime.ITripUpdate> = {}) {
  return decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: START },
    entity: [{ id: 'e', tripUpdate: { trip: { tripId: 'T', startDate: '20261019', ...trip }, stopTimeUpdate: stops, ...extra } }] }).finish());
}

describe('version-pinned normalization', () => {
  it('matches decoded vehicle dates against the pinned schedule and refuses incomplete frequency identities', async () => {
    const f = await realtimeFixture(), version = await snapshots.staticVersion(f.manifest);
    const feed = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: START }, entity: [
      { id: 'dated', vehicle: { trip: { tripId: 'T', startDate: '20261019' }, position: { latitude: 37, longitude: -122 }, timestamp: START } },
      { id: 'bare', vehicle: { trip: { tripId: 'T' }, position: { latitude: 37, longitude: -122 }, timestamp: START } },
      { id: 'invalid', vehicle: { trip: { tripId: 'T', startDate: '20260230' }, position: { latitude: 37, longitude: -122 }, timestamp: START } },
    ] }).finish());
    expect(feed.vehicles[0]).toMatchObject({ startDate: '20261019' });
    const normalize = (matching as unknown as { applyVehiclePositions: (vehicles: typeof feed.vehicles, context: matching.TripMatchContext) => Promise<typeof feed.vehicles & { tripInstanceRef?: string }[]> }).applyVehiclePositions;
    expect(normalize).toBeTypeOf('function');
    const vehicles = await normalize(feed.vehicles, { manifest: f.manifest, shards: [f.shard], version, feedId: 'sf511' });
    expect(vehicles[0]).toMatchObject({ tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDg6MDA6MDA', routeId: 'R' });
    expect(vehicles[1]?.tripInstanceRef).toBeUndefined(); expect(vehicles[2]?.tripInstanceRef).toBeUndefined();
    const frequency = await realtimeFixture('trip_id,start_time,end_time,headway_secs,exact_times\nT,08:00:00,09:00:00,600,1\n');
    const context = { manifest: frequency.manifest, shards: [frequency.shard], version: await snapshots.staticVersion(frequency.manifest), feedId: 'sf511' };
    expect((await normalize(feed.vehicles, context))[0]?.tripInstanceRef).toBeUndefined();
    const timed = { ...feed.vehicles[0]!, startTime: '08:10:00' };
    expect((await normalize([timed], context))[0]).toMatchObject({ tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDg6MTA6MDA' });
  });
  it('fails closed for duplicates without a pinned feed-wide static identity index', async () => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({ scheduleRelationship: 6 }, [], { tripProperties: { tripId: 'copy', startDate: '20261019', startTime: '09:00:00' } }),
      { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result.stopUpdates).toEqual([]);
    expect(result.degraded).toBe(true);
  });

  it('rejects a modified feed-wide identity index despite an unchanged source and manifest', async () => {
    const f = await realtimeFixture();
    await expect(matching.applyTripUpdates(decodedTrip(), { manifest: f.manifest, shards: [f.shard],
      discoveries: [{ ...f.discovery, tripProviderIds: ['different'] }], version: await snapshots.staticVersion(f.manifest) })).rejects.toThrow(/discovery|integrity/i);
  });

  it('retains sequence-only updates, dated identity, explicit zero delays and trip cancellation', () => {
    const feed = decodedTrip({ startTime: '08:00:00' }, [{ stopSequence: 1, arrival: { delay: 0 } }]);
    expect(feed.trips[0]).toMatchObject({ tripId: 'T', startDate: '20261019', startTime: '08:00:00', scheduleRelationship: 'SCHEDULED', stops: [{ stopSequence: 1, arrivalDelaySeconds: 0 }] });
    expect(feed.trips[0]?.stops[0]?.arrivalTimeSeconds).toBeUndefined();
    expect(decodedTrip({ scheduleRelationship: 3 }).trips[0]?.scheduleRelationship).toBe('CANCELED');
    expect(decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0' }, entity: [] }).finish()).producerTimestampSeconds).toBeUndefined();
  });

  it('matches an active dated instance and rejects wrong or missing service dates and mismatched versions', async () => {
    const f = await realtimeFixture();
    const pin = await snapshots.staticVersion(f.manifest);
    const query = { manifest: f.manifest, shards: [f.shard], version: pin };
    expect(matching.matchTripInstance(decodedTrip().trips[0]!, query)).toMatchObject({ serviceDate: '20261019', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDg6MDA6MDA' });
    expect(matching.matchTripInstance(decodedTrip({ startDate: '20270101' }).trips[0]!, query)).toBeNull();
    expect(matching.matchTripInstance(decodedTrip({ startDate: '' }).trips[0]!, query)).toBeNull();
    await expect(matching.applyTripUpdates(decodedTrip(), { ...query, version: { ...pin, sourceVersions: { sf511: 'a'.repeat(64) } } })).rejects.toThrow(/identity|version/i);
  });

  it('rejects an artifact-version mismatch even when source hashes match', async () => {
    const f = await realtimeFixture(); const version = await snapshots.staticVersion(f.manifest);
    await expect(Promise.resolve().then(() => matching.applyTripUpdates(decodedTrip(), { manifest: f.manifest, shards: [f.shard], version: { ...version, artifactVersion: 'a'.repeat(64) } }))).rejects.toThrow(/identity|version/i);
  });

  it('rejects mutated schedule content despite matching source identity', async () => {
    const f = await realtimeFixture(); const version = await snapshots.staticVersion(f.manifest);
    f.shard.trips[0]!.stopTimes[0]!.departureSeconds = 123;
    await expect(Promise.resolve().then(() => matching.applyTripUpdates(decodedTrip(), { manifest: f.manifest, shards: [f.shard], version }))).rejects.toThrow(/integrity|identity/i);
  });

  it('rejects manifest timezone drift even with a new manifest hash and unchanged source', async () => {
    const f = await realtimeFixture();
    f.manifest.agencyTimezones = Object.fromEntries(Object.keys(f.manifest.agencyTimezones).map(key => [key, 'UTC']));
    await expect(matching.applyTripUpdates(decodedTrip(), { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) })).rejects.toThrow(/identity/i);
  });

  it('requires frequency start_time and gives different runs distinct identities', async () => {
    const f = await realtimeFixture('trip_id,start_time,end_time,headway_secs,exact_times\nT,08:00:00,10:00:00,600,0\n');
    const query = { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) };
    expect(matching.matchTripInstance(decodedTrip({ scheduleRelationship: 2 }).trips[0]!, query)).toBeNull();
    const run = matching.matchTripInstance(decodedTrip({ scheduleRelationship: 2, startTime: '08:12:00' }).trips[0]!, query);
    expect(run).toMatchObject({ startSeconds: 29520, tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDg6MTI6MDA' });
    expect(matching.matchTripInstance(decodedTrip({ scheduleRelationship: 2, startTime: '10:00:00' }).trips[0]!, query)).toBeNull();
  });

  it('propagates delays through skipped stops, stops at NO_DATA and honors absolute time precedence', async () => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({}, [
      { stopSequence: 1, arrival: { time: START + 60, delay: 999 }, departure: { delay: 90 } },
      { stopSequence: 2, scheduleRelationship: 1 },
      { stopSequence: 4, scheduleRelationship: 2 },
    ]), { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result.stopUpdates.map(x => [x.stopSequence, x.arrivalTimeSeconds, x.departureTimeSeconds, x.status])).toEqual([
      [1, START + 60, START + 90, 'realtime'], [2, undefined, undefined, 'skipped'],
      [3, START + 690, START + 690, 'realtime'], [4, undefined, undefined, 'scheduled_only'],
    ]);
    const ambiguous = await matching.applyTripUpdates(decodedTrip({}, [{ stopId: 'S', arrival: { delay: 60 } }]), { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(ambiguous.degraded).toBe(true);
    expect(ambiguous.stopUpdates).toEqual([]);
  });

  it.each([[3, 'CANCELED']] as const)('suppresses all static calls for relationship %s', async (relationship, name) => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({ scheduleRelationship: relationship }), { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result.stopUpdates).toHaveLength(4);
    expect(result.stopUpdates.every(stop => stop.status === 'canceled' && stop.arrivalTimeSeconds === undefined)).toBe(true);
    expect(result.trips[0]?.scheduleRelationship).toBe(name);
  });

  it.each([[1, 'ADDED'], [5, 'REPLACEMENT']] as const)('keeps explicit extra service %s out of the static-match denominator', async (relationship, name) => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({ tripId: relationship === 5 ? 'T' : 'extra', routeId: 'R', scheduleRelationship: relationship }, [{ stopId: 'S', stopSequence: 1, arrival: { time: START + 10 }, departure: { time: START + 15 } }]),
      { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result.match).toEqual({ eligible: 0, matched: 0, rate: 1 });
    expect(result.stopUpdates[0]).toMatchObject({ scheduleRelationship: name, arrivalTimeSeconds: START + 10 });
  });

  it('suppresses original stops removed by a replacement trip', async () => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({ routeId: 'R', scheduleRelationship: 5 }, [{ stopId: 'S', stopSequence: 1, arrival: { time: START + 10 }, departure: { time: START + 15 } }]),
      { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result.stopUpdates.filter(s => s.status === 'canceled').map(s => s.stopSequence)).toEqual([2, 3, 4]);
    expect(result.stopUpdates[0]?.tripInstanceRef).toBe('tr:sfbay:sf511:trip:VA:20261019:MDg6MDA6MDA');
  });

  it('propagates NO_DATA until a later observation and resumes at an explicit zero delay', async () => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({}, [{ stopSequence: 2, scheduleRelationship: 2 }, { stopSequence: 4, departure: { delay: 0 } }], { delay: 60 }),
      { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result.stopUpdates.map(s => s.departureTimeSeconds)).toEqual([START + 60, undefined, undefined, START + 900]);
  });

  it('uses only explicit absolute observations for UNSCHEDULED frequency service', async () => {
    const f = await realtimeFixture('trip_id,start_time,end_time,headway_secs,exact_times\nT,08:00:00,10:00:00,600,0\n');
    const result = await matching.applyTripUpdates(decodedTrip({ scheduleRelationship: 2, startTime: '08:12:00' }, [{ stopSequence: 1, scheduleRelationship: 3, arrival: { time: START + 800 } }], { delay: 60 }),
      { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result.stopUpdates.map(s => s.arrivalTimeSeconds)).toEqual([START + 800, undefined, undefined, undefined]);
  });

  it('normalizes duplicated trips under their new dated instance without canceling the original', async () => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({ scheduleRelationship: 6 }, [], { tripProperties: { tripId: 'copy', startDate: '20261020', startTime: '09:00:00' } }),
      { manifest: f.manifest, shards: [f.shard], discoveries: [f.discovery], version: await snapshots.staticVersion(f.manifest) });
    expect(result.stopUpdates[0]).toMatchObject({ tripId: 'copy', serviceDate: '20261020', scheduledArrivalTimeSeconds: START + 90000 });
    expect(result.stopUpdates[0]?.tripInstanceRef).toBe('tr:sfbay:sf511:trip:Y29weQ:20261020:MDk6MDA6MDA');
  });

  it('degrades below the manifest match threshold and never treats unknown relationships as scheduled', async () => {
    const f = await realtimeFixture();
    const result = await matching.applyTripUpdates(decodedTrip({ tripId: 'missing' }), { manifest: f.manifest, shards: [f.shard], version: await snapshots.staticVersion(f.manifest) });
    expect(result).toMatchObject({ degraded: true, match: { eligible: 1, matched: 0, rate: 0 }, warnings: ['SCHEDULE_REALTIME_MISMATCH'] });
    for (const scheduleRelationship of [7, 8, 99]) expect(decodedTrip({ scheduleRelationship }).trips[0]).toMatchObject({ scheduleRelationship: 'UNKNOWN', rawScheduleRelationship: scheduleRelationship });
  });
});

describe('bounded snapshot storage and manifest policy', () => {
  it.each([
    ['trip_updates', 180, 'fresh', 'realtime'], ['trip_updates', 181, 'stale', 'scheduled_only'], ['trip_updates', 600, 'stale', 'scheduled_only'], ['trip_updates', 601, 'expired', 'scheduled_only'],
    ['vehicle_positions', 360, 'fresh', 'realtime'], ['vehicle_positions', 361, 'stale', 'unavailable'], ['vehicle_positions', 601, 'expired', 'unavailable'],
    ['service_alerts', 1200, 'fresh', 'realtime'], ['service_alerts', 1201, 'stale', 'realtime'],
  ] as const)('applies %s policy at age %s', (kind, age, freshness, status) => {
    const hub = new RegionalFeedHubCore(SFBAY_COVERAGE.thresholds);
    hub.replace(kind, { producerTimestampSeconds: 1000, receivedAtSeconds: 1001, payload: [] });
    expect(hub.read(kind, 1000 + age)).toMatchObject({ freshness, status, ageSeconds: age });
  });

  it('exposes per-vehicle observation ages and never lends a fresh header timestamp to an old position', () => {
    const hub = new RegionalFeedHubCore(SFBAY_COVERAGE.thresholds);
    hub.replace('vehicle_positions', { producerTimestampSeconds: 1000, receivedAtSeconds: 1000,
      payload: [{ entityId: 'v', latitude: 37, longitude: -122, timestampSeconds: 399 }, { entityId: 'u', latitude: 37, longitude: -122 }] });
    expect(hub.read('vehicle_positions', 1000).payload).toEqual([
      expect.objectContaining({ observationAgeSeconds: 601, status: 'unavailable' }), expect.objectContaining({ observationAgeSeconds: null, status: 'unavailable' }),
    ]);
  });

  it('retains observation age even after the whole vehicle feed expires', () => {
    const hub = new RegionalFeedHubCore(SFBAY_COVERAGE.thresholds);
    hub.replace('vehicle_positions', { producerTimestampSeconds: 1000, receivedAtSeconds: 1000, payload: [{ entityId: 'v', latitude: 37, longitude: -122, timestampSeconds: 990 }] });
    expect(hub.read('vehicle_positions', 1601)).toMatchObject({ status: 'unavailable', ageSeconds: 601, payload: [{ observationAgeSeconds: 611, status: 'unavailable' }] });
  });

  it('stores indexed payload shards in R2 and preserves bounded metadata across restoration', async () => {
    const db = memoryStorage(); const store = new snapshots.RealtimeSnapshotStore(db.storage, db.bucket);
    const version = await snapshots.staticVersion((await realtimeFixture()).manifest);
    const payload = Array.from({ length: 15000 }, (_, i) => ({ entityId: `e${i}`, stopId: `S${i % 100}`, label: 'x'.repeat(200) }));
    await store.publish('trip_updates', { version, producerTimestampSeconds: 1000, receivedAtSeconds: 1001, payload });
    expect(new TextEncoder().encode(JSON.stringify([...db.values])).byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(JSON.stringify([...db.values])).not.toContain('xxxxxxxxxxxxxxxx');
    expect(db.objects.size).toBeGreaterThan(1);
    const restored = new snapshots.RealtimeSnapshotStore(db.storage, db.bucket);
    const result = await restored.read('trip_updates', version, ['S1']);
    expect(result?.payload).toHaveLength(150);
    expect(result?.producerTimestampSeconds).toBe(1000);
    // A restarted coordinator loads the snapshot once; later filtered reads stay in memory.
    const loaded = db.reads.length;
    expect((await restored.read('trip_updates', version, ['S2']))?.payload).toHaveLength(150);
    expect(db.reads.length).toBe(loaded);
    const mismatch = await restored.read('trip_updates', { ...version, artifactVersion: 'a'.repeat(64) });
    expect(mismatch).toMatchObject({ payload: null, warnings: ['SCHEDULE_REALTIME_MISMATCH'] });
  });

  it('rejects oversized metadata before publishing and rejects tampered shards', async () => {
    const db = memoryStorage(); const store = new snapshots.RealtimeSnapshotStore(db.storage, db.bucket);
    const version = await snapshots.staticVersion((await realtimeFixture()).manifest);
    await expect(store.publish('trip_updates', { version, receivedAtSeconds: 1000, payload: [], warnings: ['x'.repeat(2 * 1024 * 1024)] })).rejects.toThrow(/metadata/i);
    expect(db.values.size).toBe(0);
    await store.publish('trip_updates', { version, receivedAtSeconds: 1000, payload: [{ stopId: 'S' }] });
    for (const key of db.objects.keys()) db.objects.set(key, new TextEncoder().encode('[]'));
    // The publisher serves the payload it holds; a restarted coordinator reads R2 and verifies it.
    expect((await store.read('trip_updates', version))?.payload).toEqual([{ stopId: 'S' }]);
    await expect(new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).read('trip_updates', version)).rejects.toThrow(/integrity/i);
  });

  it('stores rows column-wise without changing what a reader gets back, and keeps meaningful nulls', async () => {
    const db = memoryStorage(), version = await snapshots.staticVersion((await realtimeFixture()).manifest);
    const rows = [{ stopId: 'S', tripId: 't1', stopSequence: 3, arrivalTimeSeconds: 100 }, { stopId: 'S', tripId: 't2', departureTimeSeconds: 200, status: 'realtime' }];
    await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).publish('trip_updates', { version, receivedAtSeconds: 1000, payload: rows });
    const stored = JSON.parse(new TextDecoder().decode([...db.objects.values()][0]!));
    expect(stored).toMatchObject({ columns: ['arrivalTimeSeconds', 'departureTimeSeconds', 'status', 'stopId', 'stopSequence', 'tripId'] });
    // A restarted coordinator reads R2: the same records, absent fields still absent.
    expect((await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).read('trip_updates', version))?.payload).toEqual(rows);
    const outages = [{ id: 'EL1', stationId: 'S', estimatedReturn: null }];
    await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).publish('equipment_outages', { version, receivedAtSeconds: 1000, payload: outages });
    expect((await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).read('equipment_outages', version))?.payload).toEqual(outages);
  });

  it('fits a city of bus predictions (82,000 rows) in one snapshot', async () => {
    const db = memoryStorage(), version = await snapshots.staticVersion((await realtimeFixture()).manifest);
    const rows = Array.from({ length: 82_000 }, (_, i) => ({ entityId: `MTA NYCT_${100000 + Math.floor(i / 16)}`, tripId: `MV_E3-Weekday-SDon-0${10000 + Math.floor(i / 16)}00_M15_${i % 400}`,
      routeId: 'M15', stopId: `${400000 + (i % 3000)}`, stopSequence: i % 40, arrivalTimeSeconds: 1_792_500_000 + i, departureTimeSeconds: 1_792_500_030 + i,
      scheduledArrivalTimeSeconds: 1_792_500_000 + i, scheduledDepartureTimeSeconds: 1_792_500_000 + i, scheduleRelationship: 'SCHEDULED', stopScheduleRelationship: 'SCHEDULED',
      tripInstanceRef: `tr:nyc:mta_bus_m:trip:${Buffer.from(`MV_E3-Weekday-SDon-0${10000 + Math.floor(i / 16)}00_M15_${i % 400}`).toString('base64url')}:20261020:MDk6MDA6MDA`,
      serviceDate: '20261020', status: 'realtime', scheduleMatch: 'matched' }));
    await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).publish('trip_updates', { version, receivedAtSeconds: 1000, payload: rows });
    const read = await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).read<{ stopId: string }>('trip_updates', version);
    expect(read?.payload).toHaveLength(82_000);
    expect(read?.payload?.find(row => row.stopId === '400007')).toEqual(rows[7]);
  });

  it('tags complete payloads so a reader that holds one skips the transfer', async () => {
    const db = memoryStorage(), version = await snapshots.staticVersion((await realtimeFixture()).manifest);
    await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).publish('trip_updates', { version, receivedAtSeconds: 1000, payload: [{ stopId: 'S' }, { stopId: 'T' }] });
    const cold = new snapshots.RealtimeSnapshotStore(db.storage, db.bucket);
    const first = await cold.read('trip_updates', version), again = await cold.read('trip_updates', version);
    expect(first?.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(again?.etag).toBe(first?.etag);
    // Stop-filtered reads are partial and carry no tag.
    expect(await cold.read('trip_updates', version, ['T'])).toMatchObject({ payload: [{ stopId: 'T' }] });
    expect((await cold.read('trip_updates', version, ['T']))?.etag).toBeUndefined();
  });

  it('retains at most the current and previous snapshot payload generations after repeated polls', async () => {
    const db = memoryStorage(); const store = new snapshots.RealtimeSnapshotStore(db.storage, db.bucket);
    const version = await snapshots.staticVersion((await realtimeFixture()).manifest);
    for (let i = 0; i < 10; i++) await store.publish('trip_updates', { version, receivedAtSeconds: 1000 + i, payload: [{ stopId: 'S', value: i }] });
    expect(db.objects.size).toBe(2);
    expect((await store.read<{ value: number }>('trip_updates', version))?.payload?.[0]?.value).toBe(9);
  });

  it('recovers an interrupted shard publication without exposing partial data or retaining orphan payloads', async () => {
    const db = memoryStorage(); const store = new snapshots.RealtimeSnapshotStore(db.storage, db.bucket);
    const version = await snapshots.staticVersion((await realtimeFixture()).manifest);
    await store.publish('trip_updates', { version, receivedAtSeconds: 1000, payload: [{ stopId: 'S', value: 0 }] });
    const originalPut = db.bucket.put.bind(db.bucket); let writes = 0;
    db.bucket.put = (async (...args: Parameters<R2Bucket['put']>) => {
      if (++writes === 2) throw new Error('R2 write failed');
      return originalPut(...args);
    }) as R2Bucket['put'];
    await expect(store.publish('trip_updates', { version, receivedAtSeconds: 1001, payload: [{ stopId: 'S', value: 1 }, { stopId: 'Q', value: 2 }] })).rejects.toThrow('R2 write failed');
    expect((await store.read<{ value: number }>('trip_updates', version))?.payload?.[0]?.value).toBe(0);
    db.bucket.put = originalPut;
    await new snapshots.RealtimeSnapshotStore(db.storage, db.bucket).publish('trip_updates', { version, receivedAtSeconds: 1002, payload: [{ stopId: 'S', value: 3 }] });
    expect(db.objects.size).toBe(2);
  });

  it('keeps current and previous static manifests addressable without retaining both in the resident cache', async () => {
    const db = memoryStorage(); const store = new snapshots.StaticArtifactStore(db.bucket);
    const f = await realtimeFixture();
    const first = await store.publish(f.manifest);
    const second = await store.publish({ ...f.manifest, validator: { name: 'MobilityData GTFS Validator', version: '1', validatedAt: '2026-10-19', reportSha256: 'a'.repeat(64), systemErrorsSha256: 'b'.repeat(64), systemErrorsFormat: 'MobilityData notices' } });
    expect((await store.current())?.version).toEqual(second);
    expect((await store.read(first.artifactVersion)).version).toEqual(first);
    expect((await store.current())?.version).toEqual(second);
    expect(store.residentVersion).toBe(second.artifactVersion);
    expect(db.objects.has(`artifacts/sfbay/v2/manifests/${first.artifactVersion}.json`)).toBe(true);
    await store.publish((await store.current())!.manifest);
    expect(JSON.parse(new TextDecoder().decode(db.objects.get('artifacts/sfbay/v2/current.json')))).toMatchObject({ previous: first.artifactVersion });
  });

  it('counts failed and cross-feed attempts against one rolling API-key quota including the static reserve', async () => {
    const db = memoryStorage(); const quota = new snapshots.ApiKeyQuota(db.storage, { requestsPerHour: 60, safetyFactor: .8, reserveForStatic: 1 });
    for (let i = 0; i < 47; i++) expect(await quota.claim(i % 2 ? 'vehicle_positions' : 'trip_updates', 1000)).toBe(true);
    expect(await new snapshots.ApiKeyQuota(db.storage, { requestsPerHour: 60, safetyFactor: .8, reserveForStatic: 1 }).claim('service_alerts', 1001)).toBe(false);
    expect(await quota.claim('static', 1001)).toBe(true);
    expect(await quota.claim('static', 1002)).toBe(false);
    expect(await quota.claim('trip_updates', 4600)).toBe(true);
    expect(JSON.stringify([...db.values])).not.toContain('api_key');
  });
});

describe('GTFS realtime policy', () => {
  it('classifies producer timestamps without refreshing restored snapshots', () => {
    const now = 1_000_000;
    expect(classifyFreshness(null, now, 120)).toBe('unavailable');
    expect(classifyFreshness(now - 270, now, 120)).toBe('fresh');
    expect(classifyFreshness(now - 271, now, 120)).toBe('stale');
    expect(classifyFreshness(now - 480, now, 120)).toBe('stale');
    expect(classifyFreshness(now - 481, now, 120)).toBe('expired');
  });

  it('strips markup, controls, and bounds untrusted operator text', () => {
    expect(sanitizeTransitText('<script>ignore</script><b>Delay</b>\u0000 now', 20))
      .toBe('ignoreDelay now');
    expect(sanitizeTransitText('x'.repeat(50), 10)).toBe('xxxxxxxxxx');
  });

  it('allocates a fixed upstream budget independent of user traffic', () => {
    const intervals = allocatePollIntervals({
      requestsPerHour: 60,
      safetyFactor: 0.8,
      reserveForStatic: 1,
      feeds: [
        { id: 'tu', weight: 5, minIntervalSeconds: 120 },
        { id: 'vp', weight: 2, minIntervalSeconds: 300 },
        { id: 'alerts', weight: 1, minIntervalSeconds: 900 },
      ],
    });
    expect(intervals).toEqual({ tu: 120, vp: 300, alerts: 900 });
    const requests = Object.values(intervals).reduce((total, seconds) => total + 3600 / seconds, 1);
    expect(requests).toBeLessThanOrEqual(48);
  });

  it('adds the 511 credential only at the upstream boundary and redacts it', () => {
    const request = buildUpstreamRequest(
      new URL('https://api.511.org/transit/tripupdates?agency=RG'),
      'top-secret',
    );
    expect(request.url).toContain('api_key=top-secret');
    expect(request.headers.get('accept')).toBe('application/x-google-protobuf');
    expect(redactUpstreamUrl(request.url)).toBe(
      'https://api.511.org/transit/tripupdates?agency=RG&api_key=%5BREDACTED%5D',
    );
  });

  it('decodes trip updates, vehicles, and sanitized alerts into bounded records', () => {
    const bytes = transit_realtime.FeedMessage.encode({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_000 },
      entity: [
        {
          id: 'trip-entity',
          tripUpdate: {
            trip: { tripId: 'trip-1', routeId: 'route-1' },
            stopTimeUpdate: [{
              stopId: 'stop-1',
              arrival: { time: 1_060 },
            }],
          },
        },
        {
          id: 'vehicle-entity',
          vehicle: {
            trip: { tripId: 'trip-1', routeId: 'route-1' },
            vehicle: { id: 'vehicle-1', label: 'Train 1' },
            position: { latitude: 37.77, longitude: -122.42 },
            timestamp: 1_005,
          },
        },
        {
          id: 'alert-entity',
          alert: {
            informedEntity: [{ agencyId: 'agency-1', routeId: 'route-1', stopId: 'stop-1', trip: { tripId: 'trip-1', startDate: '20261019', startTime: '09:00:00' } }, { routeId: 'route-2' }],
            headerText: { translation: [{ text: '<b>Delay</b>' }] },
            descriptionText: { translation: [{ text: 'Use alternate service' }] },
          },
        },
      ],
    }).finish();

    const feed = decodeRealtimeFeed(bytes);
    expect(feed.producerTimestampSeconds).toBe(1_000);
    expect(feed.tripUpdates[0]).toMatchObject({ tripId: 'trip-1', stopId: 'stop-1', arrivalTimeSeconds: 1_060 });
    expect(feed.vehicles[0]?.vehicleId).toBe('vehicle-1');
    expect(feed.vehicles[0]?.latitude).toBeCloseTo(37.77, 4);
    expect(feed.vehicles[0]?.longitude).toBeCloseTo(-122.42, 4);
    expect(feed.alerts[0]).toMatchObject({ id: 'alert-entity', header: 'Delay', routeIds: ['route-1', 'route-2'], tripIds: ['trip-1'], selectors: [
      { agencyId: 'agency-1', routeId: 'route-1', stopId: 'stop-1', trip: { tripId: 'trip-1', startDate: '20261019', startTime: '09:00:00' } }, { routeId: 'route-2' },
    ] });
    expect(() => decodeRealtimeFeed(new Uint8Array([255]))).toThrow('Malformed GTFS-Realtime feed');
  });

  it('keeps stop-only vehicles and moves a stale STOPPED_AT train on to its predicted stop', () => {
    const bytes = transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: 1_000 }, entity: [
      // Reported stopped at A15N 100 s ago; the same document predicts A12N in 50 s.
      { id: 'tu-left', tripUpdate: { trip: { tripId: 'left', startDate: '20261019' }, stopTimeUpdate: [{ stopId: 'A12N', arrival: { time: 1_050 } }] } },
      { id: 'v-left', vehicle: { trip: { tripId: 'left', startDate: '20261019' }, stopId: 'A15N', currentStatus: 1, timestamp: 900 } },
      // Agrees with its prediction: still at the platform.
      { id: 'tu-here', tripUpdate: { trip: { tripId: 'here', startDate: '20261019' }, stopTimeUpdate: [{ stopId: 'A24N', arrival: { time: 990 } }] } },
      { id: 'v-here', vehicle: { trip: { tripId: 'here', startDate: '20261019' }, stopId: 'A24N', currentStatus: 1, timestamp: 980 } },
      // Waiting at a terminal with no prediction: left as reported.
      { id: 'v-terminal', vehicle: { trip: { tripId: 'terminal', startDate: '20261019' }, stopId: 'H11S', currentStatus: 1, timestamp: 800 } },
      // Neither a position nor a stop: nothing to report.
      { id: 'v-nowhere', vehicle: { trip: { tripId: 'nowhere', startDate: '20261019' }, timestamp: 990 } },
    ] })).finish();
    const feed = decodeRealtimeFeed(bytes);
    expect(feed.vehicles.map(vehicle => vehicle.entityId)).toEqual(['v-left', 'v-here', 'v-terminal']);
    expect(feed.vehicles[0]).not.toHaveProperty('latitude');
    expect(matching.settleStoppedVehicles(feed.vehicles, feed.trips).map(vehicle => [vehicle.stopId, vehicle.currentStatus, vehicle.previousStopId])).toEqual([
      ['A12N', 'IN_TRANSIT_TO', 'A15N'], ['A24N', 'STOPPED_AT', undefined], ['H11S', 'STOPPED_AT', undefined]]);
  });

  it('reads NYCT train IDs only when asked, and never fails a feed over one', async () => {
    const { feedBytes, nyctVehicle } = await import('../helpers/dc-nyc-realtime');
    const bytes = feedBytes(1_000, [nyctVehicle('054800_1..S03R', '1', '127S', 1, 990, '20261019', '01 0908 242/SFT'), nyctVehicle('054900_2..S01R', '2', '128S', 2, 990)]);
    expect(decodeRealtimeFeed(bytes, { nyct: true }).vehicles.map(vehicle => vehicle.trainId)).toEqual(['01 0908 242/SFT', undefined]);
    expect(decodeRealtimeFeed(bytes).vehicles.map(vehicle => vehicle.trainId)).toEqual([undefined, undefined]);
    // An implausible ID is ignored rather than passed through.
    const odd = feedBytes(1_000, [nyctVehicle('054800_1..S03R', '1', '127S', 1, 990, '20261019', '<script>')]);
    expect(decodeRealtimeFeed(odd, { nyct: true }).vehicles[0]).not.toHaveProperty('trainId');
  });

  it('drops alert fields whose wire type contradicts the spec instead of losing the alert', () => {
    // WMATA rail alerts as published on 2026-10-19: severity sent as a varint in field 12 (tts_header_text).
    const wmata = Uint8Array.from(Buffer.from([
      '0a0d0a03322e30100018a8b7d8d60612d5010a2439633761326639302d373661332d346532332d613032622d6534633838326136643633632aac010a',
      '0808cfabd8d60610001a0808cfabd8d60610002a051203524544300b3803520e0a0c0a0644656c6179731202656e5a790a770a71437573746f6d6572',
      '732077696c6c20657870657269656e636520726573696475616c2064656c61797320746f20476c656e6d6f6e7420666f6c6c6f77696e6720616e2065',
      '61726c69657220706f6c69636520696e7665737469676174696f6e2061742047616c6c65727920506c6163652e1202656e6004',
    ].join(''), 'hex'));
    const feed = decodeRealtimeFeed(wmata);
    expect(feed.warnings).toEqual(['dropped_mistyped_alert_field']);
    expect(feed.alerts).toMatchObject([{ id: '9c7a2f90-76a3-4e23-a02b-e4c882a6d63c', header: 'Delays', routeIds: ['RED'] }]);
    // Truncation is not a typing mistake and still fails closed.
    expect(() => decodeRealtimeFeed(wmata.subarray(0, 200))).toThrow('Malformed GTFS-Realtime feed');
  });

  it('serves snapshots without extending producer freshness or fetching upstream', () => {
    const hub = new RegionalFeedHubCore({ trip_updates: 120, vehicle_positions: 300, service_alerts: 900 });
    hub.replace('trip_updates', {
      producerTimestampSeconds: 1_000,
      receivedAtSeconds: 1_010,
      payload: { arrivals: 3 },
      warnings: ['empty_feed'],
    });

    expect(hub.read('trip_updates', 1_270)).toMatchObject({ freshness: 'fresh', payload: { arrivals: 3 }, warnings: ['empty_feed'] });
    expect(hub.read('trip_updates', 1_271)).toMatchObject({ freshness: 'stale' });
    expect(hub.read('trip_updates', 1_271).warnings).toEqual(expect.arrayContaining(['empty_feed', 'stale_feed']));
    expect(hub.read('trip_updates', 1_481)).toMatchObject({ freshness: 'expired', payload: null, warnings: ['expired_feed'] });
    expect(hub.read('vehicle_positions', 1_000)).toMatchObject({ freshness: 'unavailable', payload: null });
  });

  it('accounts failed attempts against quota and never logs credential-bearing errors', () => {
    expect(pollAttemptState('trip_updates', 1234)).toEqual({ 'polled:trip_updates': 1234 });
    expect(safePollFailureReason(new Error('fetch https://api.511.org/?api_key=secret failed'))).toBe('upstream_request_failed');
    expect(safePollFailureReason(new Error('upstream_body_too_large'))).toBe('upstream_body_too_large');
    expect(safePollFailureReason(new Error('upstream_status_401'))).toBe('upstream_status_401');
    expect(safePollFailureReason(new Error('upstream_status_401 api_key=secret'))).toBe('upstream_request_failed');
    expect(safePollFailureReason(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('upstream_timeout');
    expect(safePollFailureReason(new Error('Malformed GTFS-Realtime feed'))).toBe('malformed_feed');
  });
});
