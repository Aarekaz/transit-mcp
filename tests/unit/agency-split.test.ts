import { describe, expect, it } from 'vitest';
import { getCoverage } from '../../src/transit/core/coverage';
import { formatEntityRef } from '../../src/transit/core/refs';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { agencyGrouping, partitionSchedule } from '../../src/transit/gtfs/static/partition';
import { decodeScheduleShard } from '../../src/transit/gtfs/static/shards';
import type { GtfsScheduleFiles } from '../../src/transit/gtfs/static/schema';
import { loadScheduleWindow } from '../../src/transit/planner/schedule-index';
import { applyTripUpdates, matchTripInstance, type AppliedTripUpdates } from '../../src/transit/gtfs/realtime/trip-match';
import { staticVersion } from '../../src/transit/gtfs/realtime/snapshot-store';
import { agencyGroups, combineApplied, vehiclesFromMatches } from '../../src/transit/gtfs/realtime/region-feed-hub';

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
  it('drops block continuations only when the build says so', async () => {
    expect((await compile(false)).shard.trips.map(trip => trip.blockId).sort()).toEqual(['b1', 'b1', 'b2', 'b3']);
    expect((await compile()).shard.trips.every(trip => trip.blockId === '')).toBe(true);
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
    expect(agencyGroups(split.manifest, 'sf511')!.map(group => [...group])).toHaveLength(3);
    expect(agencyGroups(split.manifest, 'other')).toBeNull();
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

  it('resolves a trip sent without start_date only to its one instance in the poll window', async () => {
    const compiled = await compileSchedule({ coverage: getCoverage('sfbay')!, feedId: 'sf511', files: FILES, window: { startDate: '20261019', endDate: '20261020' },
      source: { url: 'https://api.511.org/transit/datafeeds', retrievedAt: '2026-10-20T01:30:33Z' }, ignoredFields: ['trips.txt:block_id'] });
    const context = (startSeconds?: number, endSeconds?: number) => ({ manifest: compiled.manifest, shards: [compiled.shard], version: undefined as never, feedId: 'sf511', tripMatching: 'exact' as const,
      ...(startSeconds !== undefined ? { undatedWindow: { startSeconds, endSeconds: endSeconds! } } : {}) });
    const version = await staticVersion(compiled.manifest);
    const at = (iso: string) => Date.parse(iso) / 1000;
    const update = { entityId: 'e', tripId: 'ba-0900', scheduleRelationship: 'SCHEDULED' as const, rawScheduleRelationship: 0, stops: [] };
    // 09:00-11:00 on the 20th holds exactly the 20th's 09:30 train.
    expect(matchTripInstance(update, { ...context(at('2026-10-20T09:00:00-07:00'), at('2026-10-20T11:00:00-07:00')), version })?.serviceDate).toBe('20261020');
    // A window spanning both days' trains is ambiguous; no window, or one missing the trip, matches nothing.
    expect(matchTripInstance(update, { ...context(at('2026-10-19T09:00:00-07:00'), at('2026-10-20T11:00:00-07:00')), version })).toBeNull();
    expect(matchTripInstance(update, { ...context(), version })).toBeNull();
    expect(matchTripInstance(update, { ...context(at('2026-10-20T12:00:00-07:00'), at('2026-10-20T14:00:00-07:00')), version })).toBeNull();
  });

  it('loads the same window whether shard bytes are fetched one at a time or ahead', async () => {
    const split = await partitionSchedule(await compile(), 3600, { agencyGroups: 3 });
    const objects = new Map(split.objects.map(object => [object.key, object.bytes]));
    const load = (readConcurrency?: number) => loadScheduleWindow({ manifest: split.manifest, instant: '2026-10-20T08:00:00-07:00', windowSeconds: 8 * 3600,
      readShard: async key => objects.get(key)!, ...(readConcurrency ? { readConcurrency } : {}) });
    const keys = (window: Awaited<ReturnType<typeof load>>) => window.shards.map(entry => entry.key);
    expect(keys(await load(8))).toEqual(keys(await load()));
    await expect(loadScheduleWindow({ manifest: split.manifest, instant: '2026-10-20T08:00:00-07:00', windowSeconds: 8 * 3600, readConcurrency: 8,
      readShard: async key => { const bytes = objects.get(key)!.slice(); bytes[bytes.length - 1]! ^= 1; return bytes; } })).rejects.toThrow(/integrity/);
  });

  it('resolves vehicles from the last trip-update matches by the same dated-or-only-instance rule', () => {
    const matches = { artifactVersion: 'v', atSeconds: 0, trips: {
      'BA:1': [['20261020', 'tr:BA:1:20261020', 'RED', 'Millbrae']], 'BA:2': [['20261019', 'tr:BA:2:19', 'RED', ''], ['20261020', 'tr:BA:2:20', 'RED', '']] } } as never;
    const vehicle = (tripId: string, startDate?: string) => ({ entityId: tripId, tripId, ...(startDate ? { startDate } : {}), tripInstanceRef: 'untrusted', latitude: 37.8, longitude: -122.4 });
    const [undated, dated, ambiguous, unknown] = vehiclesFromMatches([vehicle('BA:1'), vehicle('BA:2', '20261020'), vehicle('BA:2'), vehicle('BA:9')], matches);
    expect(undated).toMatchObject({ tripInstanceRef: 'tr:BA:1:20261020', routeId: 'RED', headsign: 'Millbrae' });
    expect(dated).toMatchObject({ tripInstanceRef: 'tr:BA:2:20' });
    expect(ambiguous!.tripInstanceRef).toBeUndefined();
    expect(unknown!.tripInstanceRef).toBeUndefined();
  });

  it('reads 511\'s renumbered sequences, repeated stops, actual start times and stale entities only under its quirks', async () => {
    // Sequences start at 2 (as Muni's do) and the train calls at s2 twice in a row (as BART's does).
    const files: GtfsScheduleFiles = { ...FILES,
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\ns1,One,37.7,-122.4\ns2,Two,37.71,-122.4\ns3,Three,37.72,-122.4\n',
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nMU:1,MU,1,California,3\n',
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nMU,Muni,https://example.com,America/Los_Angeles\n',
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign\nMU:1,D,loop,Three\n',
      'stop_times.txt': ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', 'loop,09:00:00,09:00:00,s1,2', 'loop,09:05:00,09:05:00,s2,3', 'loop,09:06:00,09:06:00,s2,4', 'loop,09:10:00,09:10:00,s3,5'].join('\n') + '\n' };
    const compiled = await compileSchedule({ coverage: getCoverage('sfbay')!, feedId: 'sf511', files, window: { startDate: '20261020', endDate: '20261020' },
      source: { url: 'https://api.511.org/transit/datafeeds', retrievedAt: '2026-10-20T01:30:33Z' } });
    const version = await staticVersion(compiled.manifest), at = (time: string) => Date.parse(`2026-10-20T${time}-07:00`) / 1000;
    const quirks = { renumberedStopSequences: true, advisoryStartTimes: true, expiredBeforeSeconds: at('08:00:00') };
    const apply = (stops: { stopId: string; stopSequence?: number; time: string }[], extra: Record<string, unknown> = {}, flags: object = quirks) => applyTripUpdates({ producerTimestampSeconds: 0, tripUpdates: [], vehicles: [], alerts: [], warnings: [],
      trips: [{ entityId: 'e', tripId: 'loop', startDate: '20261020', scheduleRelationship: 'SCHEDULED', rawScheduleRelationship: 0, ...extra,
        stops: stops.map(stop => ({ entityId: 'e', stopId: stop.stopId, stopSequence: stop.stopSequence, arrivalTimeSeconds: at(stop.time), departureTimeSeconds: at(stop.time), stopScheduleRelationship: 'SCHEDULED' as const })) }] },
      { manifest: compiled.manifest, shards: [compiled.shard], version, feedId: 'sf511', tripMatching: 'exact', ...flags });
    const predicted = (result: Awaited<ReturnType<typeof apply>>) => result.stopUpdates.filter(row => row.status === 'realtime').map(row => `${row.stopSequence}:${row.stopId}`);
    // One lower than the timetable, as 511 sends Muni and VTA: the stop decides.
    expect(predicted(await apply([{ stopId: 's1', stopSequence: 1, time: '09:01:00' }, { stopId: 's3', stopSequence: 4, time: '09:11:00' }]))).toEqual(['2:s1', '3:s2', '4:s2', '5:s3']);
    // Undated visits to a stop called twice take the next visit in order; an exact repeat is skipped.
    expect(predicted(await apply([{ stopId: 's2', time: '09:06:00' }, { stopId: 's2', time: '09:07:00' }]))).toEqual(['3:s2', '4:s2', '5:s3']);
    expect(predicted(await apply([{ stopId: 's1', stopSequence: 1, time: '09:01:00' }, { stopId: 's1', stopSequence: 1, time: '09:01:00' }]))).toHaveLength(4);
    // An actual start time still names the trip's one scheduled instance.
    expect((await apply([{ stopId: 's3', time: '09:11:00' }], { startTime: '09:00:15' })).match.matched).toBe(1);
    // Every prediction before the lookback: a stale entity, neither matched nor judged.
    expect((await apply([{ stopId: 's3', time: '07:00:00' }])).excluded.expired).toBe(1);
    // Without the quirks, the renumbered sequence is rejected and the start time must agree.
    expect((await apply([{ stopId: 's1', stopSequence: 1, time: '09:01:00' }], {}, {})).match.matched).toBe(0);
    expect((await apply([{ stopId: 's3', stopSequence: 5, time: '09:11:00' }], { startTime: '09:00:15' }, {})).match.matched).toBe(0);
  });

  it('judges schedule identity over all groups, never one small group', () => {
    const part = (eligible: number, matched: number): AppliedTripUpdates => ({ version: {} as AppliedTripUpdates['version'], trips: [], stopUpdates: [],
      match: { eligible, matched, rate: eligible ? matched / eligible : 1 }, excluded: { nonRevenue: 0, invalidExtras: 0, unrepresentableAdded: 0, beyondWindow: 0 },
      degraded: eligible > 0 && matched === 0, warnings: eligible > 0 && matched === 0 ? ['SCHEDULE_REALTIME_MISMATCH'] : [] });
    // A ferry group with one unmatched trip beside 99 matched buses is healthy.
    const healthy = combineApplied([part(99, 99), part(1, 0)], 0.95, {} as AppliedTripUpdates['version']);
    expect(healthy).toMatchObject({ degraded: false, match: { eligible: 100, matched: 99 } });
    expect(healthy.warnings).not.toContain('SCHEDULE_REALTIME_MISMATCH');
    const broken = combineApplied([part(60, 50), part(40, 30)], 0.95, {} as AppliedTripUpdates['version']);
    expect(broken).toMatchObject({ degraded: true, match: { eligible: 100, matched: 80 } });
    expect(broken.warnings).toContain('SCHEDULE_REALTIME_MISMATCH');
  });
});
