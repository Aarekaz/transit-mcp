import { describe, expect, it } from 'vitest';
import { getCoverage } from '../../src/transit/core/coverage';
import { formatEntityRef } from '../../src/transit/core/refs';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { agencyGrouping, partitionSchedule } from '../../src/transit/gtfs/static/partition';
import { decodeScheduleShard } from '../../src/transit/gtfs/static/shards';
import type { GtfsScheduleFiles } from '../../src/transit/gtfs/static/schema';
import { loadScheduleWindow } from '../../src/transit/planner/schedule-index';
import { mergeAppliedTripUpdates, type AppliedTripUpdates } from '../../src/transit/gtfs/realtime/trip-match';
import { agencyGroups } from '../../src/transit/gtfs/realtime/region-feed-hub';

/** Two bus agencies that never meet, joined by a rail backbone; every trip has a block. */
const FILES: GtfsScheduleFiles = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nMU,Muni,https://example.com,America/Los_Angeles\nAC,AC Transit,https://example.com,America/Los_Angeles\nBA,BART,https://example.com,America/Los_Angeles\n',
  'stops.txt': ['stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
    'hub,Hub,37.79,-122.39,1,', 'hub-bus,Hub bus bay,37.7901,-122.3901,0,hub', 'hub-rail,Hub platform,37.7902,-122.3902,0,hub',
    'm1,Muni 1,37.77,-122.42,0,', 'a1,AC 1,37.80,-122.27,0,', 'east,East platform,37.8,-122.27,0,'].join('\n') + '\n',
  'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nMU:1,MU,1,California,3\nAC:6,AC,6,Telegraph,3\nBA:R,BA,R,Red,1\n',
  'trips.txt': ['route_id,service_id,trip_id,trip_headsign,block_id',
    'MU:1,D,mu-0900,Hub,b1', 'MU:1,D,mu-1300,Hub,b1', 'AC:6,D,ac-0900,Uptown,b2', 'BA:R,D,ba-0900,East,b3'].join('\n') + '\n',
  'stop_times.txt': ['trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'mu-0900,09:00:00,09:00:00,m1,1', 'mu-0900,09:20:00,09:20:00,hub-bus,2',
    'mu-1300,13:00:00,13:00:00,m1,1', 'mu-1300,13:20:00,13:20:00,hub-bus,2',
    'ac-0900,09:05:00,09:05:00,east,1', 'ac-0900,09:25:00,09:25:00,a1,2',
    'ba-0900,09:30:00,09:30:00,hub-rail,1', 'ba-0900,09:45:00,09:45:00,east,2'].join('\n') + '\n',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nD,1,1,1,1,1,1,1,20261001,20261231\n',
};
const ref = (kind: 'agency' | 'stop' | 'route', id: string) => formatEntityRef({ coverage: 'sfbay', feed: 'sf511', kind, id });
const compile = (ignore = true) => compileSchedule({ coverage: getCoverage('sfbay')!, feedId: 'sf511', files: FILES, window: { startDate: '20261020', endDate: '20261020' },
  source: { url: 'https://api.511.org/transit/datafeeds', retrievedAt: '2026-10-20T01:30:33Z' }, ...(ignore ? { ignoredFields: ['trips.txt:block_id' as const] } : {}) });

describe('agency-split schedules', () => {
  it('drops block continuations only when the build says so, so bands can carry the feed', async () => {
    await expect(partitionSchedule(await compile(false), 3600)).rejects.toThrow(/block continuations/);
    const compiled = await compile();
    expect(compiled.shard.trips.every(trip => trip.blockId === '')).toBe(true);
  });

  it('groups the backbone together, then the busiest agencies, and scopes each shard to its own service', async () => {
    const compiled = await compile();
    expect(agencyGrouping(compiled.shard, 3)).toEqual([[ref('agency', 'BA')], [ref('agency', 'MU')], [ref('agency', 'AC')]]);
    expect(agencyGrouping(compiled.shard, 2)).toEqual([[ref('agency', 'BA')], [ref('agency', 'AC'), ref('agency', 'MU')].sort()]);
    const split = await partitionSchedule(compiled, 3600, { agencyGroups: 3 });
    const byKey = new Map(split.objects.map(object => [object.key, object.bytes]));
    for (const descriptor of split.manifest.shards) {
      const shard = decodeScheduleShard(byKey.get(descriptor.key)!);
      expect(descriptor.agencyRefs).toHaveLength(1);
      // Only its own agency's trips and routes, and only the stops (with their station) those trips call at.
      expect(shard.routes.every(route => descriptor.agencyRefs!.includes(route.agencyRef))).toBe(true);
      const calls = new Set(shard.trips.flatMap(trip => trip.stopTimes.map(call => call.stopRef)));
      for (const stop of shard.stops) expect(calls.has(stop.ref) || stop.locationType === 1 || stop.parentStationRef !== undefined).toBe(true);
    }
    const muni = split.manifest.shards.filter(descriptor => descriptor.agencyRefs![0] === ref('agency', 'MU'));
    expect(muni.map(descriptor => descriptor.timeRange!.bandStart)).toEqual([9 * 3600, 13 * 3600]);
    const muniStops = decodeScheduleShard(byKey.get(muni[0]!.key)!).stops.map(stop => stop.ref).sort();
    // The hub's rail platform shares the station, so it travels with Muni's bus bay.
    expect(muniStops).toEqual([ref('stop', 'hub'), ref('stop', 'hub-bus'), ref('stop', 'hub-rail'), ref('stop', 'm1')].sort());
    // Unsplit builds are unchanged: whole-feed bands with no agency names.
    const whole = await partitionSchedule(compiled, 3600);
    expect(whole.manifest.shards.every(descriptor => descriptor.agencyRefs === undefined)).toBe(true);
  });

  it('decodes only the agencies a search names', async () => {
    const split = await partitionSchedule(await compile(), 3600, { agencyGroups: 3 });
    const objects = new Map(split.objects.map(object => [object.key, object.bytes]));
    const read: string[] = [];
    const window = await loadScheduleWindow({ manifest: split.manifest, instant: '2026-10-20T09:00:00-07:00', windowSeconds: 3600,
      readShard: async key => { read.push(key); return objects.get(key)!; }, agencyRefs: [ref('agency', 'BA'), ref('agency', 'MU')] });
    const agencies = new Set(window.shards.flatMap(entry => entry.shard.routes.map(route => route.agencyRef)));
    expect([...agencies].sort()).toEqual([ref('agency', 'BA'), ref('agency', 'MU')].sort());
    expect(read.every(key => split.manifest.shards.find(descriptor => descriptor.key === key)!.agencyRefs!.some(agency => agency !== ref('agency', 'AC')))).toBe(true);
    expect(agencyGroups(split.manifest)!.map(group => [...group])).toHaveLength(3);
  });

  it('never reads the fields it declares unused, so errors about them cannot change a journey', async () => {
    const column = (csv: string, name: string, value: string) => csv.split('\n').map((line, index) => !line ? line : `${line},${index === 0 ? name : value}`).join('\n');
    const withShapes = (shape: string, distance: string): GtfsScheduleFiles => ({ ...FILES,
      'trips.txt': column(FILES['trips.txt'], 'shape_id', shape), 'stop_times.txt': column(FILES['stop_times.txt'], 'shape_dist_traveled', distance) });
    // Everything but the source's table hash (which covers every column) must be identical.
    const build = async (files: GtfsScheduleFiles) => {
      const { source, ...shard } = decodeScheduleShard((await compileSchedule({ coverage: getCoverage('sfbay')!, feedId: 'sf511', files, window: { startDate: '20261020', endDate: '20261020' },
        source: { url: 'https://api.511.org/transit/datafeeds', retrievedAt: '2026-10-20T01:30:33Z' }, ignoredFields: ['trips.txt:block_id'] })).shardBytes);
      return { ...shard, source: { ...source, sha256: '' } };
    };
    expect(await build(withShapes('S1', '1.5'))).toEqual(await build(withShapes('S2', '999')));
  });

  it('judges schedule identity over all groups, never one small group', () => {
    const part = (eligible: number, matched: number): AppliedTripUpdates => ({ version: {} as AppliedTripUpdates['version'], trips: [], stopUpdates: [],
      match: { eligible, matched, rate: eligible ? matched / eligible : 1 }, excluded: { nonRevenue: 0, invalidExtras: 0, unrepresentableAdded: 0 },
      degraded: eligible > 0 && matched === 0, warnings: eligible > 0 && matched === 0 ? ['SCHEDULE_REALTIME_MISMATCH'] : [] });
    // A ferry group with one unmatched trip beside 99 matched buses is healthy.
    const healthy = mergeAppliedTripUpdates([part(99, 99), part(1, 0)], [], {} as AppliedTripUpdates['version'], 0.95, []);
    expect(healthy).toMatchObject({ degraded: false, match: { eligible: 100, matched: 99 } });
    expect(healthy.warnings).not.toContain('SCHEDULE_REALTIME_MISMATCH');
    const broken = mergeAppliedTripUpdates([part(60, 50), part(40, 30)], [], {} as AppliedTripUpdates['version'], 0.95, []);
    expect(broken).toMatchObject({ degraded: true, match: { eligible: 100, matched: 80 } });
    expect(broken.warnings).toContain('SCHEDULE_REALTIME_MISMATCH');
  });
});
