import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCoverage } from '../../src/transit/core/coverage';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { csvRecords, parseCsvRecord } from '../../src/transit/gtfs/static/csv';
import { buildServiceDate, rangedStopTimes, scanArchive, type EdgeSource } from '../../src/transit/gtfs/static/edge-build';
import { partitionSchedule } from '../../src/transit/gtfs/static/partition';
import { sha256 } from '../../src/transit/gtfs/static/shards';
import { readZipDirectory, zipEntryText } from '../../src/transit/gtfs/static/zip';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import { BAND_SECONDS, checkStaticSources, guardRefresh, rollForwardSchedules, runRefresh, sourceKeys, type StepRunner } from '../../src/transit/gtfs/refresh/refresh';
import { bandedArtifact } from '../helpers/dc-nyc-realtime';
import type { Env } from '../../src/types';
import { DC_FILES, NOW, NYC_FILES } from '../helpers/dc-nyc-realtime';
import { memoryStorage } from '../helpers/realtime-fixture';
import { zip } from '../helpers/zip';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const nyc = (): EdgeSource => ({ coverage: getCoverage('nyc')!, feedId: 'mta_subway', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip', retrievedAt: '2026-10-19T00:00:00Z' });
const steps = (): StepRunner & { names: string[] } => {
  const names: string[] = [];
  return { names, do: async (name, run) => { names.push(name); return JSON.parse(JSON.stringify(await run())); }, sleep: async name => { names.push(name); } };
};
const chunked = (text: string, size: number) => new ReadableStream<Uint8Array>({ start(controller) {
  const bytes = new TextEncoder().encode(text);
  for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.subarray(at, at + size));
  controller.close();
} });

describe('edge GTFS reading', () => {
  it.each([8, 0] as const)('reads deflated and stored archive entries (method %s)', async method => {
    const archive = await zip({ 'stops.txt': 'stop_id\nA\n', 'nested/trips.txt': 'trip_id\nT\n' }, method);
    const entries = readZipDirectory(archive);
    expect([...entries.keys()].sort()).toEqual(['stops.txt', 'trips.txt']);
    expect(await zipEntryText(archive, entries.get('stops.txt')!)).toBe('stop_id\nA\n');
  });

  it('refuses archives it cannot read exactly', async () => {
    expect(() => readZipDirectory(new Uint8Array(64))).toThrow('Invalid ZIP archive');
    const archive = await zip({ 'stops.txt': 'stop_id\nA\n' }), corrupt = archive.slice();
    // Central entry = 46 header bytes + 'stops.txt'; its uncompressed size field is at +24.
    new DataView(corrupt.buffer).setUint32(corrupt.length - 22 - (46 + 'stops.txt'.length) + 24, 999, true);
    await expect(zipEntryText(corrupt, readZipDirectory(corrupt).get('stops.txt')!)).rejects.toThrow(/size|larger/);
  });

  it('streams records across chunk boundaries, keeping quoted line breaks, BOM and CRLF straight', async () => {
    const text = '﻿trip_id,stop_headsign\r\nT1,"Line\r\nBreak, ""quoted"""\r\nT2,Plain\r\n\r\n';
    const records: string[] = [];
    for await (const record of csvRecords(chunked(text, 3))) records.push(record);
    expect(records).toEqual(['trip_id,stop_headsign', 'T1,"Line\r\nBreak, ""quoted"""', 'T2,Plain']);
    expect(parseCsvRecord(records[1]!)).toEqual(['T1', 'Line\r\nBreak, "quoted"']);
  });
});

describe('edge schedule build', () => {
  it('produces byte-identical artifacts to a whole-feed compile, one service date at a time', async () => {
    const archive = await zip(NYC_FILES as Record<string, string>), source = nyc();
    const scan = await scanArchive(archive, source, 2, Date.parse(NOW));
    expect(scan.dates).toEqual(['20261018', '20261019', '20261020', '20261021']);
    const edge = new Map<string, Uint8Array>([[scan.discovery.key, scan.discoveryBytes]]);
    const descriptors = [];
    for (const date of scan.dates) {
      const built = await buildServiceDate(archive, source, scan.identity, date, BAND_SECONDS);
      for (const object of built.objects) edge.set(object.key, object.bytes);
      descriptors.push(...built.descriptors);
    }
    const compiled = await compileSchedule({ coverage: source.coverage, feedId: source.feedId, files: NYC_FILES, identity: scan.identity,
      window: { startDate: scan.dates[0]!, endDate: scan.dates.at(-1)! }, source: { url: source.url, retrievedAt: source.retrievedAt } });
    const offline = await partitionSchedule(compiled, BAND_SECONDS);
    expect(new Map(offline.objects.map(object => [object.key, [...object.bytes].join()]))).toEqual(new Map([...edge].map(([key, bytes]) => [key, [...bytes].join()])));
    expect(descriptors).toEqual(offline.manifest.shards);
    // Band by band from the stored stop_times copy (how a Workflow step builds): identical too.
    const copy = new TextEncoder().encode(NYC_FILES['stop_times.txt']);
    const read = async (offset: number, length: number) => copy.subarray(offset, offset + length);
    const streamed = new Map<string, Uint8Array>([[scan.discovery.key, scan.discoveryBytes]]);
    for (const date of scan.dates) {
      const built = await buildServiceDate(archive, source, scan.identity, date, BAND_SECONDS,
        { header: scan.stopTimes.header, rows: trips => rangedStopTimes(read, scan.stopTimes.header, scan.stopTimes.tripRanges, trips), starts: scan.stopTimes.tripStarts });
      for (const object of built.objects) streamed.set(object.key, object.bytes);
    }
    expect(new Map([...streamed].map(([key, bytes]) => [key, [...bytes].join()]))).toEqual(new Map([...edge].map(([key, bytes]) => [key, [...bytes].join()])));
    expect(scan.sources).toEqual(compiled.manifest.sources);
    expect(scan.identity).toMatchObject({ sha256: await sha256(archive), archiveSha256: await sha256(archive) });
  });

  it('does not depend on the row order of trips and stop times', async () => {
    const shuffle = (csv: string) => { const [header, ...rows] = csv.trim().split('\n'); return [header, ...rows.reverse()].join('\n') + '\n'; };
    const source = nyc(), archive = await zip(NYC_FILES as Record<string, string>);
    const scan = await scanArchive(archive, source, 2, Date.parse(NOW));
    const compile = (files: typeof NYC_FILES) => compileSchedule({ coverage: source.coverage, feedId: source.feedId, files, identity: scan.identity,
      window: { startDate: '20261019', endDate: '20261019' }, source: { url: source.url, retrievedAt: source.retrievedAt } });
    const ordered = await compile(NYC_FILES), reversed = await compile({ ...NYC_FILES, 'trips.txt': shuffle(NYC_FILES['trips.txt']), 'stop_times.txt': shuffle(NYC_FILES['stop_times.txt']) });
    expect([...reversed.shardBytes].join()).toBe([...ordered.shardBytes].join());
    expect([...reversed.discoveryBytes].join()).toBe([...ordered.discoveryBytes].join());
  });

  it('records an excluded publisher table as a derivation of the original archive', async () => {
    const archive = await zip({ ...DC_FILES, 'pathways.txt': 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional\nbad,PF_A03_C,PF_A02_C,7,1\n' } as Record<string, string>);
    const source: EdgeSource = { coverage: getCoverage('dc')!, feedId: 'wmata', url: 'https://api.wmata.com/gtfs/rail-gtfs-static.zip', retrievedAt: '2026-10-19T00:00:00Z',
      exclude: { files: ['pathways.txt'], reason: 'Publisher table fails validation.' } };
    const scan = await scanArchive(archive, source, 1, Date.parse(NOW));
    expect(scan.sources[0]).toMatchObject({ archiveSha256: await sha256(archive), derivedFrom: { archiveSha256: await sha256(archive), excludedFiles: ['pathways.txt'] } });
    expect(scan.identity.sha256).not.toBe(await sha256(archive));
    const built = await buildServiceDate(archive, source, scan.identity, '20261019', BAND_SECONDS);
    expect(built.trips).toBe(2); // the single-stop SHUTTLE placeholder is never service
  });

  it('refuses a source whose published dates no longer cover today', async () => {
    const archive = await zip({ ...NYC_FILES, 'feed_info.txt': 'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nMTA,https://www.mta.info/,en,20260101,20261001\n' } as Record<string, string>);
    await expect(scanArchive(archive, nyc(), 7, Date.parse(NOW))).rejects.toThrow('does not cover today');
  });
});

describe('change guards', () => {
  const stats = (trips: number, dates: Record<string, number>, stops = 100, routes = 10) => ({ trips, stops, routes, dates });
  it('accepts ordinary publisher changes and the first publication', () => {
    expect(guardRefresh(null, stats(10, { '20261019': 10 }))).toEqual([]);
    expect(guardRefresh(stats(1000, { '20261019': 900 }), stats(1010, { '20261019': 880, '20261026': 500 }))).toEqual([]);
  });
  it('rejects truncated or emptied schedules', () => {
    expect(guardRefresh(null, stats(0, {}))).toEqual(['EMPTY_SCHEDULE']);
    expect(guardRefresh(stats(1000, { '20261019': 900 }, 100, 10), stats(500, { '20261019': 200 }, 80, 5)))
      .toEqual(['STOPS_DROPPED:100->80', 'ROUTES_DROPPED:10->5', 'SERVICE_DROPPED:20261019:900->200']);
  });
});

describe('edge refresh workflow', () => {
  async function setup(files: Record<string, string> = NYC_FILES as Record<string, string>) {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const db = memoryStorage(), archive = await zip(files), hash = await sha256(archive), keys = sourceKeys('nyc');
    await db.bucket.put(keys.archive(hash), archive);
    await db.bucket.put(keys.state, JSON.stringify({ sha256: hash, checkedAt: Date.now(), retrievedAt: '2026-10-19T00:00:00Z' }));
    const stats: unknown[] = [];
    const env = { TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: '{"nyc":"on"}', REGION_FEED_HUB: { idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json(stats.length > 1 ? stats.shift() : stats[0] ?? null) }) } } as unknown as Env;
    return { db, env, hash, keys, stats, params: { coverageId: 'nyc', archiveSha256: hash, retrievedAt: '2026-10-19T00:00:00Z' } };
  }

  it('publishes one step per service date, then reports unchanged for the same archive', async () => {
    const f = await setup(), runner = steps();
    const result = await runRefresh(f.env, f.params, runner);
    expect(result.outcome).toBe('published');
    expect(runner.names.slice(0, 2)).toEqual(['scan', 'date:20261018']);
    expect(runner.names).toContain('publish');
    const current = await new StaticArtifactStore(f.db.bucket, 'nyc').current();
    expect(current?.version.artifactVersion).toBe(result.artifactVersion);
    expect(await f.db.bucket.get(f.keys.stats(result.artifactVersion!))).not.toBeNull();
    const writes = f.db.objects.size;
    expect(await runRefresh(f.env, f.params, steps())).toEqual({ outcome: 'unchanged', reasons: [] });
    expect(f.db.objects.size).toBe(writes);
  });

  it('refreshes each feed of a coverage on its own, composing one manifest', async () => {
    const f = await setup(), subway = await runRefresh(f.env, f.params, steps());
    const lirrFiles = {
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nLI,Long Island Rail Road,https://new.mta.info/agency/long-island-rail-road,America/New_York\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n237,Penn Station,40.750588,-73.993584\n102,Jamaica,40.699608,-73.808530\n',
      'routes.txt': 'route_id,route_long_name,route_type\n1,Babylon Branch,2\n',
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign,trip_short_name\n1,W,GO1,Jamaica,2\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nGO1,09:00:00,09:00:00,237,1\nGO1,09:20:00,09:20:00,102,2\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nW,20261019,1\nW,20261020,1\nW,20261021,1\n',
      // Timed trip-to-trip transfers are not compiled; the stop's own rule stays.
      'transfers.txt': 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\n102,102,GO1,GO1,1,\n102,102,,,2,300\n',
    };
    const archive = await zip(lirrFiles), hash = await sha256(archive), keys = sourceKeys('nyc', 'lirr');
    await f.db.bucket.put(keys.archive(hash), archive);
    await f.db.bucket.put(keys.state, JSON.stringify({ sha256: hash, checkedAt: Date.now(), retrievedAt: '2026-10-19T00:00:00Z' }));
    const lirr = await runRefresh(f.env, { coverageId: 'nyc', feedId: 'lirr', archiveSha256: hash, retrievedAt: '2026-10-19T00:00:00Z' }, steps());
    expect(lirr.outcome).toBe('published');
    const store = new StaticArtifactStore(f.db.bucket, 'nyc');
    const before = (await store.read(subway.artifactVersion!)).manifest, after = (await store.read(lirr.artifactVersion!)).manifest;
    expect(after.sources.map(source => source.feedId)).toEqual(['lirr', 'mta_subway']);
    // The subway's part of the manifest is exactly as it was published.
    expect(after.shards.filter(shard => shard.feedId === 'mta_subway')).toEqual(before.shards);
    const stats = await (await f.db.bucket.get(f.keys.stats(lirr.artifactVersion!)))!.json<{ feeds: Record<string, { trips: number }> }>();
    expect(Object.keys(stats.feeds).sort()).toEqual(['lirr', 'mta_subway']);
    // A later subway refresh keeps the LIRR's part and its archive.
    const changed = await zip({ ...NYC_FILES, 'trips.txt': NYC_FILES['trips.txt'].replace('South Ferry,1\n', 'South Ferry Loop,1\n') } as Record<string, string>), changedHash = await sha256(changed);
    await f.db.bucket.put(f.keys.archive(changedHash), changed);
    await f.db.bucket.put(f.keys.state, JSON.stringify({ sha256: changedHash, checkedAt: Date.now(), retrievedAt: 'later' }));
    vi.setSystemTime(Date.now() + 3 * 3600_000);
    const again = await runRefresh(f.env, { ...f.params, archiveSha256: changedHash }, steps());
    expect(again.outcome).toBe('published');
    const latest = (await store.read(again.artifactVersion!)).manifest;
    expect(latest.shards.filter(shard => shard.feedId === 'lirr')).toEqual(after.shards.filter(shard => shard.feedId === 'lirr'));
    expect(await f.db.bucket.head(keys.archive(hash))).not.toBeNull();
    expect(await f.db.bucket.head(keys.state)).not.toBeNull();
  });

  it('splits a dense feed by band in its own steps and still publishes the offline bytes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const busFiles = {
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\n1,WMATA,https://www.wmata.com,America/New_York\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nB1,Connecticut Av NW+Dupont Cir,38.90990,-77.04410\nB2,Wisconsin Av NW+M St NW,38.90510,-77.06240\n',
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nD80,1,D80,Union Station,3\n',
      // Trip IDs out of time order, as Metrobus publishes them: each band's rows are scattered.
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign,block_id\nD80,Weekday,9003,South,A1\nD80,Weekday,9001,South,A1\nD80,Weekday,9002,North,A2\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n9003,11:10:00,11:10:00,B1,1\n9003,11:25:00,11:25:00,B2,2\n' +
        '9001,09:03:00,09:03:00,B1,1\n9001,09:15:00,09:15:00,B2,2\n9002,09:40:00,09:40:00,B2,1\n9002,09:55:00,09:55:00,B1,2\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWeekday,1,1,1,1,1,0,0,20261001,20261031\n',
    };
    const db = memoryStorage(), archive = await zip(busFiles), hash = await sha256(archive), keys = sourceKeys('dc', 'wmata_bus');
    await db.bucket.put(keys.archive(hash), archive);
    await db.bucket.put(keys.state, JSON.stringify({ sha256: hash, checkedAt: Date.now(), retrievedAt: '2026-10-19T00:00:00Z' }));
    const env = { TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: '{"dc":"off"}' } as unknown as Env, runner = steps();
    const result = await runRefresh(env, { coverageId: 'dc', feedId: 'wmata_bus', archiveSha256: hash, retrievedAt: '2026-10-19T00:00:00Z' }, runner);
    expect(result.outcome).toBe('published');
    expect(runner.names.slice(0, 7)).toEqual(['scan', 'band:9', 'yield:band:9', 'band:11', 'yield:band:11', 'date:20261018', 'yield:date:20261018']);
    const manifest = (await new StaticArtifactStore(db.bucket, 'dc').read(result.artifactVersion!)).manifest;
    const dates = [...new Set(manifest.shards.map(shard => shard.window.startDate))].sort();
    const source = { coverage: getCoverage('dc')!, feedId: 'wmata_bus', url: 'https://api.wmata.com/gtfs/bus-gtfs-static.zip', retrievedAt: '2026-10-19T00:00:00Z' };
    const identity = (await scanArchive(archive, source, 7, Date.parse(NOW))).identity;
    const offline = await partitionSchedule(await compileSchedule({ coverage: source.coverage, feedId: 'wmata_bus', files: busFiles, identity,
      window: { startDate: dates[0]!, endDate: dates.at(-1)! }, source: { url: source.url, retrievedAt: source.retrievedAt } }), 3600);
    expect(manifest.shards).toEqual(offline.manifest.shards);
    for (const shard of manifest.shards) {
      const published = new Uint8Array(await (await db.bucket.get(shard.key))!.arrayBuffer());
      expect([...published].join()).toBe([...offline.objects.find(object => object.key === shard.key)!.bytes].join());
    }
    expect([...db.objects.keys()].some(key => key.startsWith('work/'))).toBe(false);
  });

  it('never publishes an archive superseded while it was building', async () => {
    const f = await setup();
    await f.db.bucket.put(f.keys.state, JSON.stringify({ sha256: 'f'.repeat(64), checkedAt: Date.now(), retrievedAt: 'x' }));
    expect(await runRefresh(f.env, f.params, steps())).toMatchObject({ outcome: 'superseded' });
    expect(await new StaticArtifactStore(f.db.bucket, 'nyc').current()).toBeNull();
  });

  it('rejects a refresh that removes most of a date\'s service, keeping the published version', async () => {
    const f = await setup(), first = await runRefresh(f.env, f.params, steps());
    const truncated = { ...NYC_FILES, 'stop_times.txt': NYC_FILES['stop_times.txt'].split('\n').filter(line => !line.includes('_1..S03R')).join('\n') } as Record<string, string>;
    const archive = await zip(truncated), hash = await sha256(archive);
    await f.db.bucket.put(f.keys.archive(hash), archive);
    await f.db.bucket.put(f.keys.state, JSON.stringify({ sha256: hash, checkedAt: Date.now(), retrievedAt: 'later' }));
    const result = await runRefresh(f.env, { ...f.params, archiveSha256: hash }, steps());
    expect(result.outcome).toBe('rejected');
    expect(result.reasons!.some(reason => reason.startsWith('SERVICE_DROPPED'))).toBe(true);
    expect((await new StaticArtifactStore(f.db.bucket, 'nyc').current())?.version.artifactVersion).toBe(first.artifactVersion);
  });

  it('rolls back when live matching regresses against the version it replaced', async () => {
    const f = await setup(), first = await runRefresh(f.env, f.params, steps());
    const changed = { ...NYC_FILES, 'trips.txt': NYC_FILES['trips.txt'].replace('South Ferry,1\n', 'South Ferry Loop,1\n') } as Record<string, string>;
    const archive = await zip(changed), hash = await sha256(archive);
    await f.db.bucket.put(f.keys.archive(hash), archive);
    await f.db.bucket.put(f.keys.state, JSON.stringify({ sha256: hash, checkedAt: Date.now(), retrievedAt: 'later' }));
    const store = new StaticArtifactStore(f.db.bucket, 'nyc');
    // Baseline before publishing, then the coordinator re-matches against the new version.
    f.stats.push({ artifactVersion: first.artifactVersion, eligible: 100, matched: 80, rate: 0.8, atSeconds: 1 });
    const runner = steps(), original = runner.do;
    runner.do = async (name, run) => {
      const value = await original(name, run);
      if (name === 'publish') f.stats.splice(0, f.stats.length, { artifactVersion: value as string, eligible: 100, matched: 40, rate: 0.4, atSeconds: 2 });
      return value;
    };
    const result = await runRefresh(f.env, { ...f.params, archiveSha256: hash }, runner);
    expect(result.outcome).toBe('rolled_back');
    expect((await store.pointer())).toEqual({ current: first.artifactVersion, previous: result.artifactVersion });
  });

  it('keeps current and previous versions and collects older, unreferenced objects', async () => {
    const f = await setup();
    const publish = async (headsign: string) => {
      const archive = await zip({ ...NYC_FILES, 'trips.txt': NYC_FILES['trips.txt'].replace('South Ferry,1\n', `${headsign},1\n`) } as Record<string, string>), hash = await sha256(archive);
      await f.db.bucket.put(f.keys.archive(hash), archive);
      await f.db.bucket.put(f.keys.state, JSON.stringify({ sha256: hash, checkedAt: Date.now(), retrievedAt: 'x' }));
      vi.setSystemTime(Date.now() + 3 * 3600_000); // older objects become collectable
      return runRefresh(f.env, { ...f.params, archiveSha256: hash }, steps());
    };
    const first = await runRefresh(f.env, f.params, steps());
    const firstManifest = (await new StaticArtifactStore(f.db.bucket, 'nyc').read(first.artifactVersion!)).manifest;
    const second = await publish('South Ferry A'), third = await publish('South Ferry B');
    expect([second.outcome, third.outcome]).toEqual(['published', 'published']);
    const store = new StaticArtifactStore(f.db.bucket, 'nyc');
    expect(await store.pointer()).toEqual({ current: third.artifactVersion, previous: second.artifactVersion });
    for (const version of [second.artifactVersion!, third.artifactVersion!]) {
      for (const object of (await store.read(version)).manifest.shards) expect(f.db.objects.has(object.key)).toBe(true);
    }
    // The first version's own shards are gone; its archive too. No scratch objects remain.
    const onlyFirst = firstManifest.shards.filter(object => !(f.db.objects.has(object.key)));
    expect(onlyFirst.length).toBeGreaterThan(0);
    expect(f.db.objects.has(`artifacts/nyc/v2/manifests/${first.artifactVersion}.json`)).toBe(false);
    expect(f.db.objects.has(f.keys.archive(f.hash))).toBe(false);
    expect([...f.db.objects.keys()].some(key => key.startsWith('work/'))).toBe(false);
  });

  it('rebuilds an unchanged archive before its published window runs out', async () => {
    const f = await setup();
    expect((await runRefresh(f.env, f.params, steps())).outcome).toBe('published');
    const archive = new Uint8Array(await (await f.db.bucket.get(f.keys.archive(f.hash)))!.arrayBuffer());
    const created: string[] = [];
    const env = { ...f.env, TRANSIT_REFRESH: { create: async (options: { id: string }) => {
      if (created.includes(options.id)) throw new Error('instance already exists');
      created.push(options.id);
    }, get: async () => ({ status: async () => ({ status: 'running' }), restart: async () => {} }) } } as unknown as Env;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input instanceof Request ? input.url : input).includes('gtfs_supplemented')
      ? new Response(archive, { headers: { etag: '"same"' } }) : new Response(null, { status: 503 }));
    vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Freshly built: a full window ahead, nothing to do.
    await checkStaticSources(env, Date.now());
    expect(created).toEqual([]);
    // Five days on, under half the window is left: rebuild the same archive, once that day.
    vi.setSystemTime(Date.now() + 5 * 86_400_000);
    await checkStaticSources(env, Date.now());
    await checkStaticSources(env, Date.now() + 10 * 60_000);
    expect(created).toEqual([`refresh-nyc-${f.hash.slice(0, 32)}-w${new Date(Date.now()).toISOString().slice(0, 10).replaceAll('-', '')}`]);
  });

  it('treats a re-zipped archive with the same tables as unchanged, and rebuilds when a table changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const db = memoryStorage(), files = NYC_FILES as Record<string, string>, created: string[] = [];
    // The same tables in another order and compression: other bytes, same content.
    const first = await zip(files), rezipped = await zip(Object.fromEntries(Object.entries(files).reverse()), 0);
    const changed = await zip({ ...files, 'trips.txt': files['trips.txt']! + files['trips.txt']!.trim().split('\n').at(-1)!.replace(/^([^,]*,[^,]*,)([^,]*)/, '$1$2_added') + '\n' });
    expect(await sha256(first)).not.toBe(await sha256(rezipped));
    let served = first;
    const env = { TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: '{"nyc":"on"}', TRANSIT_REFRESH: {
      create: async (options: { id: string }) => { if (created.includes(options.id)) throw new Error('instance already exists'); created.push(options.id); },
      get: async () => ({ status: async () => ({ status: 'running' }), restart: async () => {} }) } } as unknown as Env;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input instanceof Request ? input.url : input).includes('gtfs_supplemented')
      ? new Response(served) : new Response(null, { status: 503 }));
    vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = async (archive: Uint8Array, at: number) => { served = archive; await checkStaticSources(env, Date.now() + at * 10 * 60_000); };
    await check(first, 0);
    await check(rezipped, 1);
    expect(created).toEqual([`refresh-nyc-${(await sha256(first)).slice(0, 32)}`]);
    expect(await db.bucket.get(sourceKeys('nyc').archive(await sha256(rezipped)))).toBeNull();
    await check(changed, 2);
    expect(created).toHaveLength(2);
    expect(created[1]).toBe(`refresh-nyc-${(await sha256(changed)).slice(0, 32)}`);
  });

  it('builds a change near now at once and lets a change days ahead wait six hours', async () => {
    // "Later" runs only a week ahead, so trips added on it leave yesterday, today and tomorrow alone.
    const files = { ...NYC_FILES, 'calendar_dates.txt': 'service_id,date,exception_type\nLater,20261027,1\n' } as Record<string, string>;
    const add = (id: string, service: string) => ({ ...files, 'trips.txt': `${files['trips.txt']}F,${id},${service},Coney Island-Stillwell Av,1\n`,
      'stop_times.txt': `${files['stop_times.txt']}${id},11:00:00,11:00:00,D19S,1\n${id},11:30:00,11:30:00,132S,2\n` });
    const f = await setup(files);
    // Published from an archive fetched an hour ago.
    expect((await runRefresh(f.env, { ...f.params, retrievedAt: new Date(Date.now() - 3600_000).toISOString() }, steps())).outcome).toBe('published');
    const created: string[] = [];
    let served = await zip(add('LATER-F-1', 'Later'));
    const env = { ...f.env, TRANSIT_REFRESH: { create: async (options: { id: string }) => {
      if (created.includes(options.id)) throw new Error('instance already exists');
      created.push(options.id);
    }, get: async () => ({ status: async () => ({ status: 'running' }), restart: async () => {} }) } } as unknown as Env;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input instanceof Request ? input.url : input).includes('gtfs_supplemented')
      ? new Response(served) : new Response(null, { status: 503 }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = async () => `refresh-nyc-${(await sha256(served)).slice(0, 32)}`;
    await checkStaticSources(env, Date.now());
    await checkStaticSources(env, Date.now() + 10 * 60_000);
    expect(created).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('schedule_refresh_deferred'));
    // Still within the hour: a trip added for today is built on the next check.
    served = await zip(add('TODAY-F-1', 'Weekday'));
    await checkStaticSources(env, Date.now() + 20 * 60_000);
    expect(created).toEqual([await id()]);
    // A change days ahead waits only until the published archive is six hours old.
    served = await zip(add('LATER-F-2', 'Later'));
    await checkStaticSources(env, Date.now() + 30 * 60_000);
    expect(created).toHaveLength(1);
    await checkStaticSources(env, Date.now() + 5 * 3600_000 + 60_000);
    expect(created).toEqual([created[0], await id()]);
  });

  it('restarts a failed refresh for the current archive a bounded number of times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const db = memoryStorage(), archive = await zip(NYC_FILES as Record<string, string>);
    let restarts = 0;
    const env = { TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: '{"nyc":"on"}', TRANSIT_REFRESH: {
      create: async () => { throw new Error('instance already exists'); },
      get: async () => ({ status: async () => ({ status: 'errored' }), restart: async () => { restarts++; } }) } } as unknown as Env;
    // Only the subway archive answers; NYC's other feeds fail their own checks independently.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input instanceof Request ? input.url : input).includes('gtfs_supplemented')
      ? new Response(archive, { headers: { etag: '"v1"' } }) : new Response(null, { status: 503 }));
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let check = 0; check < 5; check++) await checkStaticSources(env, Date.now() + check * 10 * 60_000);
    expect(restarts).toBe(3);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('schedule_refresh_gave_up'));
  });

  it('fetches the 511 archive only within its quota, streams it to storage and leaves the build offline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const db = memoryStorage(), archive = await zip({ 'agency.txt': 'agency_id\n' }), hash = await sha256(archive);
    let allowed = false, claims = 0;
    const created: unknown[] = [];
    const env = { TRANSIT_ARTIFACTS: db.bucket, SFBAY_MODE: 'dark', TRANSIT_COVERAGE_MODES: '{}', SF511_API_KEY: 'secret-token',
      REGION_FEED_HUB: { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (url: string) => {
        expect(name).toBe('sfbay:511'); expect(url).toContain('/quota/static'); claims++;
        return Response.json({ allowed });
      } }) },
      TRANSIT_REFRESH: { create: async (options: unknown) => { created.push(options); }, get: async () => { throw new Error('unused'); } } } as unknown as Env;
    const requests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { const request = new Request(input as RequestInfo, init); requests.push(request); return new Response(archive); });
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The coordinator refuses: no request leaves, and the failure names no token.
    await checkStaticSources(env, Date.now());
    expect(claims).toBe(1); expect(requests).toHaveLength(0);
    expect(warnings.mock.calls.flat().join(' ')).toContain('source_quota_exhausted');
    expect(warnings.mock.calls.flat().join(' ')).not.toContain('secret-token');
    allowed = true;
    await checkStaticSources(env, Date.now() + 60_000);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).searchParams.get('operator_id')).toBe('RG');
    expect(new URL(requests[0]!.url).searchParams.get('api_key')).toBe('secret-token');
    expect(await db.bucket.head(sourceKeys('sfbay').archive(hash))).not.toBeNull();
    expect(await db.bucket.head('sources/sfbay/incoming.zip')).toBeNull();
    // A reviewed offline build publishes SF; the cron never starts an edge build.
    expect(created).toEqual([]);
    expect(JSON.stringify(await (await db.bucket.get(sourceKeys('sfbay').state))!.json())).not.toContain('secret-token');
  });

  it('checks sources cheaply: conditional requests, one refresh per new archive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const db = memoryStorage(), archive = await zip(NYC_FILES as Record<string, string>), hash = await sha256(archive);
    const created: { id: string; params: unknown }[] = [];
    const env = { TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: '{"nyc":"on"}', WMATA_API_KEY: 'k',
      TRANSIT_REFRESH: { create: async (options: { id: string; params: unknown }) => {
        if (created.some(item => item.id === options.id)) throw new Error('instance already exists');
        created.push(options);
      }, get: async () => ({ status: async () => ({ status: 'running' }), restart: async () => { throw new Error('must not restart a running refresh'); } }) } } as unknown as Env;
    const requests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init); requests.push(request);
      if (!request.url.includes('gtfs_supplemented')) return new Response(null, { status: 503 });
      return request.headers.get('if-none-match') === '"v1"' ? new Response(null, { status: 304 }) : new Response(archive, { headers: { etag: '"v1"' } });
    });
    vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    await checkStaticSources(env, Date.now());
    // The primary feed keeps the instance ID it had before coverages held several feeds.
    expect(created).toEqual([{ id: `refresh-nyc-${hash.slice(0, 32)}`, params: { coverageId: 'nyc', feedId: 'mta_subway', archiveSha256: hash, retrievedAt: new Date(NOW).toISOString() } }]);
    expect(await db.bucket.head(sourceKeys('nyc').archive(hash))).not.toBeNull();
    // Inside the interval: no request at all.
    await checkStaticSources(env, Date.now() + 60_000);
    expect(requests.filter(request => request.url.includes('gtfs_supplemented'))).toHaveLength(1);
    // Next interval: a 304 costs no body and starts nothing new.
    await checkStaticSources(env, Date.now() + 10 * 60_000);
    const conditional = requests.filter(request => request.url.includes('gtfs_supplemented')).at(-1)!;
    expect(conditional.headers.get('if-none-match')).toBe('"v1"');
    expect(created).toHaveLength(1);
    // DC is not active in this environment and is never contacted.
    expect(requests.some(request => request.url.includes('wmata'))).toBe(false);
  });
});

describe('rolling forward a timetable rolled back too early', () => {
  // WMATA publishes the next rail timetable the evening before it starts: the canary sees live
  // trips still on the old one and rolls back; the next morning the old one matches nothing.
  async function rolledBack(retrievedNewer = '2026-10-20T22:15:33.345Z') {
    const { db, partitioned } = await bandedArtifact('dc');
    const store = new StaticArtifactStore(db.bucket, 'dc');
    const old = await store.publish(partitioned.manifest);
    const newer = structuredClone(partitioned.manifest);
    newer.sources = newer.sources.map(source => ({ ...source, sha256: 'f'.repeat(64), retrievedAt: retrievedNewer }));
    const next = await store.publish(newer);
    await store.rollback(next.artifactVersion);
    return { db, store, old: old.artifactVersion, next: next.artifactVersion };
  }
  function envWith(db: Awaited<ReturnType<typeof rolledBack>>['db'], stats: object | null, calls: string[] = []) {
    return { TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: '{"dc":"on"}', REGION_FEED_HUB: { idFromName: (name: string) => name,
      get: () => ({ fetch: async (url: string) => { calls.push(url); return Response.json(stats); } }) } } as unknown as Env;
  }
  const now = Date.parse('2026-10-21T13:50:00Z');
  afterEach(() => vi.restoreAllMocks());

  it('switches forward when live matching collapses on the timetable it rolled back to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await rolledBack(), calls: string[] = [];
    await rollForwardSchedules(envWith(f.db, { artifactVersion: f.old, eligible: 142, matched: 0, rate: 0, atSeconds: now / 1000 - 60 }, calls), now);
    expect(await f.store.pointer()).toEqual({ current: f.next, previous: f.old });
    // A routine check never wakes a sleeping coordinator.
    expect(calls.every(url => url.includes('peek=1'))).toBe(true);
  });

  it('stays put while live data matches, on stale stats, or when the other timetable is not newer', async () => {
    const healthy = await rolledBack();
    await rollForwardSchedules(envWith(healthy.db, { artifactVersion: healthy.old, eligible: 142, matched: 140, rate: 0.99, atSeconds: now / 1000 - 60 }), now);
    expect((await healthy.store.pointer())?.current).toBe(healthy.old);
    const stale = await rolledBack();
    await rollForwardSchedules(envWith(stale.db, { artifactVersion: stale.old, eligible: 142, matched: 0, rate: 0, atSeconds: now / 1000 - 3600 }), now);
    expect((await stale.store.pointer())?.current).toBe(stale.old);
    const older = await rolledBack('2026-10-01T00:00:00Z');
    await rollForwardSchedules(envWith(older.db, { artifactVersion: older.old, eligible: 142, matched: 0, rate: 0, atSeconds: now / 1000 - 60 }), now);
    expect((await older.store.pointer())?.current).toBe(older.old);
  });
});
