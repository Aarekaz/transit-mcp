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
  return { manifest, compiled, reads, readDiscovery: async (key: string) => {
    if (key !== manifest.discoveries[0]!.key) throw new Error('Unexpected discovery read');
    return compiled[0]!.discoveryBytes;
  }, readShard: async (key: string) => {
    reads.push(key);
    const bytes = objects.get(key);
    if (!bytes) throw new Error('Unexpected shard read');
    return bytes;
  } };
}

describe('schedule-window metadata', () => {
  it('pins discovery to the same source version as the timetable', async () => {
    const result = await compileSchedule(input());
    expect(result.discovery).toMatchObject({ sourceSha256: result.manifest.sources[0]!.sha256 });
    expect(result.manifest).toMatchObject({ discoveries: [{ feedId: 'sf511',
      key: expect.any(String), sha256: await sha256(result.discoveryBytes), byteLength: result.discoveryBytes.length }] });
  });
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

describe('frequency service windows', () => {
  function frequencyInput() {
    const data = input();
    data.files['stops.txt'] += 'O,Origin,37,-122,0,\n';
    data.files['stop_times.txt'] = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type\nT,09:00:00,09:00:00,O,1,0\nT,09:05:00,09:05:00,P,2,0\n';
    data.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,600,0\n';
    return data;
  }

  it('preserves frequency-only service as offset-adjusted windows with dated template identity', async () => {
    const f = await fixture(frequencyInput());
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T09:10:00-07:00', windowSeconds: 600 });
    expect(result.departures).toEqual([]);
    expect(result.frequencyWindows).toEqual([{
      tripRef: 'tr:sfbay:sf511:trip:VA', tripTemplateRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA',
      serviceDate: '20261019', routeRef: ROUTE, agencyRef: 'tr:sfbay:sf511:agency:X19hbm9ueW1vdXNfYWdlbmN5X18',
      stopRef: 'tr:sfbay:sf511:stop:UA', stopSequence: 2, headsign: 'Ocean Beach', directionId: 0, pickupType: 0,
      startTime: '2026-10-19T09:05:00-07:00', endTime: '2026-10-19T10:05:00-07:00',
      overlapStartTime: '2026-10-19T09:10:00-07:00', overlapEndTime: '2026-10-19T09:20:00-07:00',
      headwaySeconds: 600, exactTimes: false, status: 'scheduled_only', feedId: 'sf511',
      scheduleVersion: f.manifest.sources[0]!.sha256, agencyTimezone: 'America/Los_Angeles',
    }]);
  });

  it.each([
    ['2026-10-19T09:04:00-07:00', 60, 0],
    ['2026-10-19T09:05:00-07:00', 1, 1],
    ['2026-10-19T10:04:59-07:00', 1, 1],
    ['2026-10-19T10:05:00-07:00', 60, 0],
  ])('uses half-open frequency and query windows at %s', async (instant, windowSeconds, count) => {
    const f = await fixture(frequencyInput());
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant, windowSeconds });
    expect(result.frequencyWindows).toHaveLength(count);
    expect(result.departures).toEqual([]);
  });

  it('keeps approximate windows separate from first/last exact departures without duplicating service', async () => {
    const data = frequencyInput();
    data.files['trips.txt'] += 'R,D,U,Downtown,0\n';
    data.files['stop_times.txt'] += 'U,09:15:00,09:15:00,P,1,0\n';
    data.files['frequencies.txt'] += 'T,10:00:00,11:00:00,900,0\nU,09:15:00,10:00:00,600,1\n';
    const f = await fixture(data);
    const q = { ...f, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 3 * 3600, limit: 1 };
    const first = await getScheduledDepartures({ ...q, selection: 'first' });
    const last = await getScheduledDepartures({ ...q, selection: 'last' });
    expect(first.departures.map(d => d.scheduledTime)).toEqual(['2026-10-19T09:15:00-07:00']);
    expect(last.departures.map(d => d.scheduledTime)).toEqual(['2026-10-19T09:55:00-07:00']);
    expect(first.frequencyWindows).toHaveLength(2);
    expect(last.frequencyWindows).toEqual(first.frequencyWindows);
    expect(first.frequencyWindows.every(w => w.exactTimes === false && !('scheduledTime' in w))).toBe(true);
  });

  it('retains the final fractional second of an overnight frequency service window', async () => {
    const data = frequencyInput();
    data.files['calendar.txt'] = data.files['calendar.txt']!.split('\n')[0]! + '\n';
    data.files['calendar_dates.txt'] = 'service_id,date,exception_type\nD,20261018,1\n';
    data.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,24:00:00,25:00:00,600,0\n';
    const f = await fixture(data);
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T01:04:59.500-07:00', windowSeconds: 1 });
    expect(result.frequencyWindows).toEqual([expect.objectContaining({ serviceDate: '20261018',
      startTime: '2026-10-19T00:05:00-07:00', endTime: '2026-10-19T01:05:00-07:00',
      overlapStartTime: '2026-10-19T01:04:59.500-07:00', overlapEndTime: '2026-10-19T01:05:00-07:00' })]);
  });

  it('rejects discovery of a frequency window beyond its declared timetable bound', async () => {
    const f = await fixture(frequencyInput());
    expect(() => decodeScheduleShard(encodeScheduleShard({ ...f.compiled[0]!.shard, maxStopTimeSeconds: 36299 })))
      .toThrow(/shard/i);
  });

  it('deduplicates identical frequency evidence before enforcing the result bound', async () => {
    const data = frequencyInput();
    data.files['frequencies.txt'] += 'T,09:00:00,10:00:00,600,0\n'.repeat(101);
    const f = await fixture(data);
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 3600 });
    expect(result.frequencyWindows).toHaveLength(1);
  });

  it('refuses more than 100 unique overlapping windows rather than silently truncating', async () => {
    const data = frequencyInput();
    const time = (minute: number) => `${String(9 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
    data.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\n' +
      Array.from({ length: 101 }, (_, i) => `T,${time(i)},${time(i + 1)},60,0\n`).join('');
    const f = await fixture(data);
    await expect(getScheduledDepartures({ ...f, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 7200 }))
      .rejects.toThrow('TIME_OUTSIDE_WINDOW: more than 100 frequency windows; narrow the search window or filters');
  });
});

describe('stop identity independent of agency filters', () => {
  it.each([undefined, [], ['tr:sfbay:sf511:agency:X19hbm9ueW1vdXNfYWdlbmN5X18'], ['tr:sfbay:sf511:agency:WA']] as const)
    ('rejects an unknown stop for agency filters %j', async agencyRefs => {
      const f = await fixture();
      await expect(getScheduledDepartures({ ...f, stopRef: 'tr:sfbay:sf511:stop:WA',
        agencyRefs: agencyRefs ? [...agencyRefs] : undefined, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 }))
        .rejects.toThrow(/ENTITY_NOT_FOUND/);
    });

  it('returns empty service for a valid stop with no matching agency even outside timetable coverage', async () => {
    const f = await fixture();
    const result = await getScheduledDepartures({ ...f, stopRef: STOP, agencyRefs: ['tr:sfbay:sf511:agency:WA'],
      instant: '2027-01-01T09:00:00-08:00', windowSeconds: 60 });
    expect(result).toMatchObject({ status: 'scheduled_only', departures: [], frequencyWindows: [] });
    expect(f.reads).toEqual([]);
  });

  it('rejects unknown stops before an uncovered timetable can mask identity failure', async () => {
    const f = await fixture();
    await expect(getScheduledDepartures({ ...f, stopRef: 'tr:sfbay:sf511:stop:WA',
      instant: '2027-01-01T09:00:00-08:00', windowSeconds: 60 })).rejects.toThrow(/ENTITY_NOT_FOUND/);
  });

  it('rejects corrupt or incorrectly sized discovery bytes before reading any timetable', async () => {
    const f = await fixture();
    const q = { ...f, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 };
    const corrupt = f.compiled[0]!.discoveryBytes.slice(); corrupt[0] = 0;
    await expect(getScheduledDepartures({ ...q, readDiscovery: async () => corrupt })).rejects.toThrow(/discovery integrity/i);
    await expect(getScheduledDepartures({ ...q, readDiscovery: async () => corrupt.slice(1) })).rejects.toThrow(/discovery integrity/i);
    expect(f.reads).toEqual([]);
  });

  it.each(['coverageId', 'feedId', 'sourceSha256'])('rejects a discovery %s identity mismatch with valid bytes/hash', async field => {
    const f = await fixture();
    const bytes = new TextEncoder().encode(JSON.stringify({ ...f.compiled[0]!.discovery, [field]: field === 'sourceSha256' ? 'a'.repeat(64) : 'other' }));
    const manifest = { ...f.manifest, discoveries: [{ ...f.manifest.discoveries[0]!, byteLength: bytes.length, sha256: await sha256(bytes) }] };
    await expect(getScheduledDepartures({ ...f, manifest, readDiscovery: async () => bytes, stopRef: STOP,
      instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 })).rejects.toThrow(/discovery identity/i);
    expect(f.reads).toEqual([]);
  });
});

describe('multi-feed discovery', () => {
  async function twoFeeds() {
    const a = await compileSchedule(input());
    const other = input();
    other.feedId = 'other';
    other.coverage = { ...other.coverage, feeds: [...other.coverage.feeds, { ...other.coverage.feeds[0]!, id: 'other' }] };
    other.files['stop_times.txt'] = other.files['stop_times.txt'].replaceAll('09:00', '10:00');
    const b = await compileSchedule(other);
    const descriptors = await Promise.all([a, b].map(async compiled => {
      const hash = await sha256(compiled.discoveryBytes);
      return { feedId: compiled.shard.feedId, key: `artifacts/sfbay/v2/${compiled.shard.feedId}/discovery/${hash}.json`,
        sha256: hash, byteLength: compiled.discoveryBytes.length };
    }));
    const manifest = { ...a.manifest, sources: [...a.manifest.sources, ...b.manifest.sources], discoveries: descriptors,
      agencyTimezones: { ...a.manifest.agencyTimezones, ...b.manifest.agencyTimezones }, shards: [...a.manifest.shards, ...b.manifest.shards] };
    const objects = new Map([
      [descriptors[0]!.key, a.discoveryBytes], [descriptors[1]!.key, b.discoveryBytes],
      [a.manifest.shards[0]!.key, a.shardBytes], [b.manifest.shards[0]!.key, b.shardBytes],
    ]);
    const reads: string[] = [];
    const read = async (key: string) => {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) throw new Error('Unexpected multi-feed artifact read');
      return bytes;
    };
    return { manifest, readDiscovery: read, readShard: read, reads, a, b };
  }

  it('queries known stops in either feed using only that feed discovery and timetable', async () => {
    const f = await twoFeeds();
    for (const [stopRef, scheduledTime, feedId] of [
      ['tr:sfbay:sf511:stop:Uw', '2026-10-19T09:00:30-07:00', 'sf511'],
      ['tr:sfbay:other:stop:Uw', '2026-10-19T10:00:30-07:00', 'other'],
    ] as const) {
      f.reads.length = 0;
      const result = await getScheduledDepartures({ ...f, stopRef, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 7200 });
      expect(result.departures.map(d => [d.scheduledTime, d.feedId])).toEqual([[scheduledTime, feedId]]);
      expect(f.reads).toEqual([f.manifest.discoveries.find(d => d.feedId === feedId)!.key, f.manifest.shards.find(s => s.feedId === feedId)!.key]);
    }
  });

  it.each(['missing', 'duplicate', 'wrong_feed'] as const)('fails closed on %s queried-feed discovery descriptors', async variation => {
    const f = await fixture();
    // Independent artifact descriptor keeps this test focused on selection rather than bytes.
    const descriptor = { feedId: 'sf511', key: 'test-discovery', sha256: await sha256(f.compiled[0]!.discoveryBytes), byteLength: f.compiled[0]!.discoveryBytes.length };
    const discoveries = variation === 'missing' ? [] : variation === 'duplicate' ? [descriptor, descriptor] : [{ ...descriptor, feedId: 'other' }];
    const manifest = { ...f.manifest, discoveries };
    await expect(getScheduledDepartures({ ...f, manifest, stopRef: STOP, instant: '2026-10-19T09:00:00-07:00', windowSeconds: 60 }))
      .rejects.toThrow(/discovery identity/i);
    expect(f.reads).toEqual([]);
  });

  it('rejects discovery bytes from another source despite valid descriptor hash and feed', async () => {
    const f = await twoFeeds();
    const stale = new TextEncoder().encode(JSON.stringify({ ...f.b.discovery, sourceSha256: f.a.shard.source.sha256 }));
    f.manifest.discoveries[1] = { ...f.manifest.discoveries[1]!, sha256: await sha256(stale), byteLength: stale.length };
    await expect(getScheduledDepartures({ ...f, readDiscovery: async () => stale, stopRef: 'tr:sfbay:other:stop:Uw',
      instant: '2026-10-19T09:00:00-07:00', windowSeconds: 7200 })).rejects.toThrow(/discovery identity/i);
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
