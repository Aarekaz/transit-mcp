import { describe, expect, it } from 'vitest';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { partitionSchedule } from '../../src/transit/gtfs/static/partition';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { decodeScheduleShard, encodeScheduleShard } from '../../src/transit/gtfs/static/shards';
import { loadScheduleWindow } from '../../src/transit/planner/schedule-index';
import { decodeRealtimeFeed } from '../../src/transit/gtfs/realtime/decode';
import { aliasAlertAgencies, mergeRealtimeParts } from '../../src/transit/gtfs/realtime/region-feed-hub';
import { realtimeTripKey } from '../../src/transit/gtfs/realtime/trip-match';
import { NYC_COVERAGE } from '../../src/regions/nyc';
import type { GtfsScheduleFiles } from '../../src/transit/gtfs/static/schema';
import { feedBytes } from '../helpers/dc-nyc-realtime';

const files = (extra: Partial<GtfsScheduleFiles> = {}): GtfsScheduleFiles => ({
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nMTA NYCT,MTA,http://www.mta.info,America/New_York\n',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,A,40.7,-74\nB,B,40.71,-74\n',
  'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\n1,MTA NYCT,1,Local,1\n',
  'trips.txt': 'route_id,service_id,trip_id\n1,Weekday,early\n1,Weekday,morning\n1,Weekday,overnight\n1,Weekend,weekend\n',
  'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nearly,05:00:00,05:00:00,A,1\nearly,05:20:00,05:20:00,B,2\n' +
    'morning,08:50:00,08:50:00,A,1\nmorning,09:40:00,09:40:00,B,2\novernight,25:00:00,25:00:00,A,1\novernight,25:30:00,25:30:00,B,2\n' +
    'weekend,10:00:00,10:00:00,A,1\nweekend,10:10:00,10:10:00,B,2\n',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWeekday,1,1,1,1,1,0,0,20261001,20261031\nWeekend,0,0,0,0,0,0,0,20261001,20261031\n',
  ...extra,
});
const compile = (extra?: Partial<GtfsScheduleFiles>) => compileSchedule({ coverage: NYC_COVERAGE, feedId: 'mta_subway', files: files(extra),
  window: { startDate: '20261019', endDate: '20261020' }, source: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip', retrievedAt: '2026-10-18T00:00:00Z' } });

describe('time-banded schedule shards', () => {
  it('partitions each service date by first departure and bounds every band by its calls', async () => {
    const { manifest, shards } = await partitionSchedule(await compile(), 3 * 3600);
    expect(manifest.shards.map(shard => [shard.window.startDate, shard.timeRange!.bandStart / 3600, shard.timeRange!.start / 3600, shard.timeRange!.end / 3600])).toEqual([
      ['20261019', 3, 5, 5 + 20 / 60], ['20261019', 6, 8 + 50 / 60, 9 + 40 / 60], ['20261019', 24, 25, 25.5],
      ['20261020', 3, 5, 5 + 20 / 60], ['20261020', 6, 8 + 50 / 60, 9 + 40 / 60], ['20261020', 24, 25, 25.5],
    ]);
    // Inactive service is never published into a date's bands.
    expect(shards.flatMap(shard => shard.trips.map(trip => trip.providerId))).not.toContain('weekend');
    for (const shard of shards) expect(decodeScheduleShard(encodeScheduleShard(shard))).toEqual(shard);
  });

  it('loads only the bands whose calls overlap the query, including the previous service day', async () => {
    const { manifest, objects } = await partitionSchedule(await compile(), 3 * 3600);
    const bytes = new Map(objects.map(object => [object.key, object.bytes]));
    const reads: string[] = [];
    const window = await loadScheduleWindow({ manifest, instant: '2026-10-20T01:10:00-04:00', windowSeconds: 1800, feedIds: ['mta_subway'],
      readShard: async key => { reads.push(key); return bytes.get(key)!; } });
    expect(window.status).toBe('scheduled_only');
    // 01:10 on the 20th is 25:10 of service day 19: only that day's overnight band.
    expect(window.shards.map(entry => [entry.shard.window.startDate, entry.shard.trips.map(trip => trip.providerId)])).toEqual([['20261019', ['overnight']]]);
    expect(reads).toHaveLength(1);
  });

  it('marks a date with no service explicitly instead of making it look expired', async () => {
    const compiled = await compileSchedule({ coverage: NYC_COVERAGE, feedId: 'mta_subway', files: files(),
      window: { startDate: '20261024', endDate: '20261024' }, source: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip', retrievedAt: '2026-10-18T00:00:00Z' } });
    const { manifest, objects } = await partitionSchedule(compiled, 3 * 3600);
    expect(manifest.shards).toHaveLength(1);
    const bytes = new Map(objects.map(object => [object.key, object.bytes]));
    const window = await loadScheduleWindow({ manifest, instant: '2026-10-24T12:00:00-04:00', windowSeconds: 3600, readShard: async key => bytes.get(key)! });
    expect(window).toMatchObject({ status: 'scheduled_only', reasons: [] });
  });

  it('refuses inputs a band boundary could silently cut', async () => {
    await expect(partitionSchedule(await compile({ 'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nmorning,08:50:00,10:00:00,600\n' }), 3 * 3600)).rejects.toThrow(/frequency/);
    // Staying in your seat from one trip to another cannot be split across bands.
    await expect(partitionSchedule(await compile({ 'transfers.txt': 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type\nB,B,early,morning,4\n' }), 3 * 3600)).rejects.toThrow(/trip-specific/);
  });

  it('keeps blocks on trips, publishes no block table, and compiles no timed trip transfer', async () => {
    const { shards } = await partitionSchedule(await compile({ 'trips.txt': 'route_id,service_id,trip_id,block_id\n1,Weekday,early,b1\n1,Weekday,morning,b1\n1,Weekday,overnight,\n1,Weekend,weekend,\n' }), 3 * 3600);
    expect(shards.every(shard => Object.keys(shard.blocks).length === 0)).toBe(true);
    expect([...new Set(shards.flatMap(shard => shard.trips).filter(trip => trip.blockId === 'b1').map(trip => trip.providerId))].sort()).toEqual(['early', 'morning']);
    for (const shard of shards) expect(decodeScheduleShard(encodeScheduleShard(shard)).trips.length).toBe(shard.trips.length);
    // A timed transfer only promises a hold; the stop's own rule applies instead.
    const timed = await compile({ 'transfers.txt': 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\nB,B,early,morning,1,\nB,B,,,2,120\n' });
    expect(timed.shard.transfers).toEqual([expect.objectContaining({ transferType: 2, minTransferSeconds: 120 })]);
    await expect(partitionSchedule(timed, 3 * 3600)).resolves.toBeDefined();
  });

  it('carries only the stops a band serves, with their stations', async () => {
    const { shards } = await partitionSchedule(await compile(), 3 * 3600);
    for (const shard of shards) {
      const served = new Set(shard.trips.flatMap(trip => trip.stopTimes.map(call => call.stopRef)));
      for (const stop of shard.stops) expect(served.has(stop.ref) || shard.stops.some(child => child.parentStationRef === stop.ref)).toBe(true);
      for (const ref of served) expect(shard.stops.some(stop => stop.ref === ref)).toBe(true);
    }
  });

  it('rejects a band holding a trip outside its declared range', async () => {
    const { shards } = await partitionSchedule(await compile(), 3 * 3600);
    const tampered = { ...shards[0]!, timeRange: { ...shards[0]!.timeRange!, bandStart: 6 * 3600, bandEnd: 9 * 3600 } };
    expect(() => decodeScheduleShard(encodeScheduleShard(tampered))).toThrow('Invalid schedule shard');
  });
});

describe('provider realtime adapters', () => {
  it('derives the NYCT realtime trip_id from the scheduled trip_id', () => {
    expect(realtimeTripKey('AFA25GEN-1092-Weekday-00_054800_1..S03R', 'nyct_suffix')).toBe('054800_1..S03R');
    expect(realtimeTripKey('14362694_20741', 'exact')).toBe('14362694_20741');
  });

  it('treats a zero alert bound as open, not as an invalid period', () => {
    const feed = decodeRealtimeFeed(feedBytes(1_792_369_291, [{ id: 'a', alert: { informedEntity: [{ routeId: 'RED' }], activePeriod: [{ start: 1_792_205_175, end: 0 }, { start: 0, end: 1_792_400_000 }] } }]));
    expect(feed.warnings).toEqual([]);
    expect(feed.alerts[0]!.activePeriods).toEqual([{ start: 1_792_205_175 }, { end: 1_792_400_000 }]);
  });

  it('dates a multi-document merge by its oldest document and keeps an empty document as an answer', () => {
    const merged = mergeRealtimeParts([decodeRealtimeFeed(feedBytes(200, [])), decodeRealtimeFeed(feedBytes(100, [])), decodeRealtimeFeed(feedBytes(300, []))]);
    expect(merged.producerTimestampSeconds).toBe(100);
    const unstamped = decodeRealtimeFeed(transitHeaderless());
    expect(mergeRealtimeParts([decodeRealtimeFeed(feedBytes(200, [])), unstamped]).producerTimestampSeconds).toBeUndefined();
  });

  it('rewrites only reviewed alert agency aliases', () => {
    const alerts = [{ id: 'x', header: '', description: '', routeIds: [], stopIds: [], selectors: [{ agencyId: 'MTASBWY', routeId: 'A' }, { agencyId: 'OTHER' }] }];
    expect(aliasAlertAgencies(alerts, { MTASBWY: 'MTA NYCT' })[0]!.selectors).toEqual([{ agencyId: 'MTA NYCT', routeId: 'A' }, { agencyId: 'OTHER' }]);
  });
});

function transitHeaderless(): Uint8Array {
  // A feed whose header omits its timestamp cannot vouch for freshness.
  return transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0' }, entity: [] })).finish();
}
