import { describe, expect, it, vi } from 'vitest';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { decodeScheduleShard, encodeScheduleShard, sha256 } from '../../src/transit/gtfs/static/shards';
import type { ArtifactManifestV2, CompileScheduleInput } from '../../src/transit/gtfs/static/schema';
import { SFBAY_COVERAGE } from '../../src/regions/sfbay';
import { getScheduledDepartures } from '../../src/transit/planner/departures';
import { loadScheduleWindow } from '../../src/transit/planner/schedule-index';

const STOP = 'tr:sfbay:sf511:stop:Uw' as const;
const ROUTE = 'tr:sfbay:sf511:route:Ug' as const;
function input(): CompileScheduleInput {
  return {
    coverage: SFBAY_COVERAGE, feedId: 'sf511', window: { startDate: '20260101', endDate: '20261231' },
    // Intentionally old retrieval: calendar coverage, never generation age, establishes validity.
    source: { url: 'https://511.org/open-data/transit', retrievedAt: '2020-01-01T00:00:00Z' },
    files: {
      'agency.txt': 'agency_name,agency_url,agency_timezone\nMuni,https://sfmta.com,America/Los_Angeles\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS,Station,37,-122,1,\nP,Platform,37,-122,0,S\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR,N,Judah,0\n',
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id\nR,D,T,Ocean Beach,0\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type\nT,09:00:00,09:00:30,P,1,0\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nD,1,1,1,1,1,1,1,20260101,20261231\n',
    },
  };
}
async function fixture(data = input(), windows = [data.window]) {
  const compiled = await Promise.all(windows.map(window => compileSchedule({ ...data, window })));
  const manifest: ArtifactManifestV2 = { ...compiled[0]!.manifest, shards: compiled.flatMap(c => c.manifest.shards) };
  const objects = new Map(compiled.map(c => [c.manifest.shards[0]!.key, c.shardBytes]));
  const reads: string[] = [];
  return { manifest, compiled, reads, readShard: async (key: string) => {
    reads.push(key);
    const bytes = objects.get(key);
    if (!bytes) throw new Error('Unexpected shard read');
    return bytes;
  } };
}

describe('schedule-window metadata', () => {
  // Catch a loader lookback bound that silently drops legal trips after 48:00.
  it('publishes a feed-wide maximum even in a shard excluding the long trip', async () => {
    const data = input();
    data.files['stop_times.txt'] = data.files['stop_times.txt'].replaceAll('09:00', '49:00');
    data.files['calendar_dates.txt'] = 'service_id,date,exception_type\nD,20261019,2\n';
    data.window = { startDate: '20261019', endDate: '20261019' };
    const result = await compileSchedule(data);
    expect(result.manifest.shards[0]).toMatchObject({ maxStopTimeSeconds: 176430 });
    expect(result.shard).toMatchObject({ maxStopTimeSeconds: 176430, trips: [] });
  });

  it('rejects a shard whose bound understates actual stop times', async () => {
    const result = await compileSchedule(input());
    const bytes = encodeScheduleShard({ ...result.shard, maxStopTimeSeconds: 1 });
    expect(() => decodeScheduleShard(bytes)).toThrow(/shard/i);
  });
});

describe('scheduled departures', () => {
  it('returns exact departures with dated refs, source version, offsets and anonymous agency identity', async () => {
    const f = await fixture();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    try {
      const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 });
      expect(result.status).toBe('scheduled_only');
      expect(result.departures).toEqual([expect.objectContaining({
        tripRef: 'tr:sfbay:sf511:trip:VA', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MzA',
        routeRef: ROUTE, stopRef: 'tr:sfbay:sf511:stop:UA', serviceDate: '20261019',
        agencyRef: 'tr:sfbay:sf511:agency:X19hbm9ueW1vdXNfYWdlbmN5X18',
        scheduledTime: '2026-10-19T09:00:30-07:00', predictedTime: null,
        scheduleVersion: f.manifest.sources[0]!.sha256, feedId: 'sf511', status: 'scheduled_only',
      })]);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['25:00', '20261018', '2026-10-19T01:00:30-07:00'],
    ['49:00', '20261017', '2026-10-19T01:00:30-07:00'],
  ])('finds %s trips on their actual service date across shard boundaries', async (time, serviceDate, scheduledTime) => {
    const data = input(); data.files['stop_times.txt'] = data.files['stop_times.txt'].replaceAll('09:00', time);
    data.files['calendar.txt'] = data.files['calendar.txt']!.split('\n')[0]! + '\n';
    data.files['calendar_dates.txt'] = `service_id,date,exception_type\nD,${serviceDate},1\n`;
    const f = await fixture(data, [
      { startDate: '20261016', endDate: '20261018' }, { startDate: '20261019', endDate: '20261020' },
      { startDate: '20261101', endDate: '20261103' },
    ]);
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T01:00:00-07:00', windowSeconds: 60 });
    expect(result.departures.map(d => [d.serviceDate, d.scheduledTime])).toEqual([[serviceDate, scheduledTime]]);
    expect(f.reads).toEqual(f.manifest.shards.slice(0, 2).map(s => s.key));
  });

  it.each([
    ['2026-03-08T01:20:00-08:00', '02:30', '2026-03-08T01:30:00-08:00'],
    ['2026-03-08T03:20:00-07:00', '03:30', '2026-03-08T03:30:00-07:00'],
    ['2026-11-01T01:20:00-07:00', '00:30', '2026-11-01T01:30:00-07:00'],
    ['2026-11-01T01:20:00-08:00', '01:30', '2026-11-01T01:30:00-08:00'],
    ['2026-03-07T23:20:00-08:00', '00:30', '2026-03-07T23:30:00-08:00'],
  ])('resolves schedule seconds across DST at %s', async (instant, time, scheduledTime) => {
    const data = input(); data.files['stop_times.txt'] = data.files['stop_times.txt'].replaceAll('09:00', time).replace(':30,P', ':00,P');
    const f = await fixture(data);
    expect((await getScheduledDepartures({ ...f, stopRef: STOP, instant, windowSeconds: 1200 })).departures.map(d => d.scheduledTime))
      .toEqual([scheduledTime]);
  });

  it('honors holiday removals and additions outside the weekly calendar', async () => {
    const data = input();
    data.files['calendar.txt'] = data.files['calendar.txt']!.replace('20261231', '20261018');
    data.files['calendar_dates.txt'] = 'service_id,date,exception_type\nD,20261018,2\nD,20261019,1\n';
    const f = await fixture(data);
    for (const [instant, count] of [['2026-10-18T09:00:00-07:00', 0], ['2026-10-19T09:00:00-07:00', 1]] as const) {
      const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant, windowSeconds: 60 });
      expect(result.status).toBe('scheduled_only'); expect(result.departures).toHaveLength(count);
    }
  });

  it('returns unavailable with no partial departures when a requested date is uncovered', async () => {
    const f = await fixture(input(), [{ startDate: '20261018', endDate: '20261019' }]);
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T08:00:00-07:00', windowSeconds: 2 * 86400 });
    expect(result).toMatchObject({ status: 'unavailable', reasons: ['SCHEDULE_EXPIRED'], departures: [] });
  });

  it('applies feed_info validity instead of trusting a wider artifact window', async () => {
    const data = input(); data.files['feed_info.txt'] = 'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\n511,https://511.org,en,20261001,20261018\n';
    const f = await fixture(data);
    expect(await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T08:00:00-07:00', windowSeconds: 3600 }))
      .toMatchObject({ status: 'unavailable', reasons: ['SCHEDULE_EXPIRED'], departures: [] });
  });

  it('selects first and last within a half-open bounded future window, with stable ordering', async () => {
    const data = input();
    data.files['trips.txt'] += 'R,D,U,Downtown,1\nR,D,V,Depot,1\n';
    data.files['stop_times.txt'] += 'U,10:00:00,10:00:00,P,1,0\nV,11:00:00,11:00:00,P,1,0\n';
    const f = await fixture(data);
    const query = { ...f, stopRef: STOP, instant: '2026-10-19T09:00:30-07:00', windowSeconds: 7170, limit: 1 };
    expect((await getScheduledDepartures({ ...query, selection: 'first' })).departures.map(d => d.scheduledTime)).toEqual(['2026-10-19T09:00:30-07:00']);
    expect((await getScheduledDepartures({ ...query, selection: 'last' })).departures.map(d => d.scheduledTime)).toEqual(['2026-10-19T10:00:00-07:00']);
    await expect(getScheduledDepartures({ ...query, windowSeconds: 8 * 86400 })).rejects.toThrow(/TIME_OUTSIDE_WINDOW/);
    await expect(getScheduledDepartures({ ...query, windowSeconds: 0 })).rejects.toThrow(/TIME_OUTSIDE_WINDOW/);
    await expect(getScheduledDepartures({ ...query, instant: '2026-10-19T09:00:00' })).rejects.toThrow(/offset/i);
  });

  it('omits no-pickup and untimed calls and honors route/agency filters', async () => {
    const data = input(); data.files['trips.txt'] += 'R,D,U,Depot,1\nR,D,V,Depot,1\n';
    data.files['stop_times.txt'] += 'U,09:00:45,09:00:45,P,1,1\nV,,,P,1,0\n';
    const f = await fixture(data);
    const q = { ...f, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 };
    expect((await getScheduledDepartures({ ...q, routeRefs: [ROUTE] })).departures).toHaveLength(1);
    expect((await getScheduledDepartures({ ...q, routeRefs: ['tr:sfbay:sf511:route:WA'] })).departures).toHaveLength(0);
    await expect(getScheduledDepartures({ ...q, stopRef: ROUTE })).rejects.toThrow(/INVALID_TRANSIT_REF/);
  });

  it('expands exact frequency instances and never publishes non-exact templates as precise departures', async () => {
    const data = input();
    data.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,600,1\n';
    const f = await fixture(data);
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 1800 });
    expect(result.departures.map(d => d.scheduledTime)).toEqual(['2026-10-19T09:00:00-07:00', '2026-10-19T09:10:00-07:00', '2026-10-19T09:20:00-07:00']);
    expect(new Set(result.departures.map(d => d.tripInstanceRef)).size).toBe(3);
    data.files['frequencies.txt'] = data.files['frequencies.txt'].replace(',600,1', ',600,0');
    const nonExact = await fixture(data);
    expect((await getScheduledDepartures({ ...nonExact, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 1800 })).departures).toEqual([]);
  });

  it('uses each route agency timezone and applies an agency filter without reading another feed', async () => {
    const data = input();
    data.files['agency.txt'] = 'agency_id,agency_name,agency_url,agency_timezone\nA,West,https://west.example,America/Los_Angeles\nB,East,https://east.example,America/New_York\n';
    data.files['routes.txt'] = 'route_id,agency_id,route_short_name,route_type\nR,A,W,2\nE,B,E,2\n';
    data.files['trips.txt'] += 'E,D,U,East,0\n';
    data.files['stop_times.txt'] += 'U,12:00:00,12:00:00,P,1,0\n';
    const f = await fixture(data);
    f.manifest.sources.push({ ...f.manifest.sources[0]!, feedId: 'irrelevant' });
    f.manifest.shards.push({ ...f.manifest.shards[0]!, feedId: 'irrelevant', key: 'do-not-read' });
    const query = { ...f, stopRef: STOP, instant: '2026-10-19T16:00:00Z', windowSeconds: 60 };
    const all = await getScheduledDepartures(query);
    expect(all.departures.map(d => [d.scheduledTime, d.agencyTimezone])).toEqual([
      ['2026-10-19T12:00:00-04:00', 'America/New_York'], ['2026-10-19T09:00:30-07:00', 'America/Los_Angeles'],
    ]);
    expect(f.reads).toEqual([f.manifest.shards[0]!.key]);
    expect((await getScheduledDepartures({ ...query, agencyRefs: ['tr:sfbay:sf511:agency:Qg'] })).departures.map(d => d.routeRef))
      .toEqual(['tr:sfbay:sf511:route:RQ']);
  });

  it('respects weekly non-service days and resolves a future Sunday independently of the wall clock', async () => {
    const data = input(); data.files['calendar.txt'] = data.files['calendar.txt']!.replace('D,1,1,1,1,1,1,1,', 'D,1,1,1,1,1,0,0,');
    const f = await fixture(data);
    expect((await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-18T00:00:00-07:00', windowSeconds: 86400 })).departures).toEqual([]);
  });
});

describe('lazy schedule loading', () => {
  it('returns unavailable for a manifest with no published feeds', async () => {
    const f = await fixture();
    const manifest = { ...f.manifest, sources: [], shards: [], agencyTimezones: {} };
    expect(await loadScheduleWindow({ ...f, manifest, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 }))
      .toMatchObject({ status: 'unavailable', reasons: ['COVERAGE_UNAVAILABLE'], shards: [] });
  });

  it('rejects corrupted bytes and a mismatched source version before using a shard', async () => {
    const f = await fixture();
    const q = { ...f, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60, feedIds: ['sf511'] };
    const corrupt = f.compiled[0]!.shardBytes.slice(); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await expect(loadScheduleWindow({ ...q, readShard: async () => corrupt })).rejects.toThrow(/integrity/i);
    const other = encodeScheduleShard({ ...f.compiled[0]!.shard, source: { ...f.compiled[0]!.shard.source, sha256: 'a'.repeat(64) } });
    const manifest = { ...f.manifest, shards: [{ ...f.manifest.shards[0]!, sha256: await sha256(other), byteLength: other.length }] };
    await expect(loadScheduleWindow({ ...q, manifest, readShard: async () => other })).rejects.toThrow(/identity/i);
  });

  it('refuses an oversized working set before any shard read', async () => {
    const f = await fixture(); f.manifest.shards[0]!.byteLength = 65 * 1024 * 1024;
    await expect(loadScheduleWindow({ ...f, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 })).rejects.toThrow(/budget/i);
    expect(f.reads).toEqual([]);
  });

  it('rejects altered provenance even when source hash and bytes match', async () => {
    const f = await fixture();
    const q = { ...f, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 };
    const manifest = { ...f.manifest, sources: [{ ...f.manifest.sources[0]!, feedInfo: [{ feed_end_date: '20261201' }] }] };
    await expect(loadScheduleWindow({ ...q, manifest })).rejects.toThrow(/identity/i);
  });

  it('rejects omitted agency timezones instead of silently missing that agency service', async () => {
    const data = input();
    data.files['agency.txt'] = 'agency_id,agency_name,agency_url,agency_timezone\nA,West,https://west.example,America/Los_Angeles\nB,East,https://east.example,America/New_York\n';
    data.files['routes.txt'] = 'route_id,agency_id,route_short_name,route_type\nR,A,W,2\n';
    const f = await fixture(data);
    delete f.manifest.agencyTimezones['tr:sfbay:sf511:agency:Qg'];
    await expect(loadScheduleWindow({ ...f, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 })).rejects.toThrow(/identity/i);
  });
});
