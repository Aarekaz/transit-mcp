import { describe, expect, it } from 'vitest';
import { parseGtfsCsv } from '../../src/transit/gtfs/static/csv';
import { parseGtfsTime } from '../../src/transit/gtfs/static/time';
import { encodeTransitId, transitResourceUri } from '../../src/regions/ids';
import { routeTypeToMode } from '../../src/transit/gtfs/static/modes';
import { createStaticArtifact, searchStops } from '../../src/transit/gtfs/static/artifact';
import { compileGtfsStatic } from '../../src/transit/gtfs/static/compiler';
import * as compiler from '../../src/transit/gtfs/static/compiler';
import * as shards from '../../src/transit/gtfs/static/shards';
import * as artifacts from '../../src/transit/gtfs/static/artifact';
import { SFBAY_COVERAGE } from '../../src/regions/sfbay';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// These cases catch lost GTFS semantics, unstable ordering and invalid graphs
// entering the published schedule; expectations are hand-derived fixture values.
function scheduleInput() {
  return {
    coverage: SFBAY_COVERAGE, feedId: 'sf511',
    window: { startDate: '20261018', endDate: '20261020' },
    source: { url: 'https://511.org/open-data/transit', retrievedAt: '2026-10-17T00:00:00Z' },
    files: {
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA,Muni,https://sfmta.com,America/Los_Angeles\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS,Station,37,-122,1,\nP1,Platform 1,37,-122,0,S\nP2,Platform 2,37,-122,0,S\nN,,37,-122,3,S\n',
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,A,N,Judah,0\n',
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,block_id,wheelchair_accessible,bikes_allowed\nR,WK,T,Ocean Beach,0,B,1,2\nR,EX,X,Downtown,1,,0,0\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT,25:10:00,25:10:00,P2,20,1,0\nT,25:00:00,25:00:30,P1,10,0,1\nX,12:00:00,12:00:00,P2,1,0,0\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261001,20261031\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nWK,20261019,2\nEX,20261018,1\n',
      'feed_info.txt': 'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n511,https://511.org,en,20261001,20261031,october\n',
      'frequencies.txt': 'trip_id,start_time,end_time,headway_secs,exact_times\nT,25:00:00,26:00:00,600,1\n',
      'transfers.txt': 'from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\nP1,P2,R,R,T,X,2,120\n',
      'pathways.txt': 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,traversal_time\nPATH,N,P1,1,1,45\n',
    },
  };
}

function mutateShardMetadata(bytes: Uint8Array, mutate: (metadata: Record<string, unknown>) => void): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const oldLength = view.getUint32(4, true), oldOffset = Math.ceil((16 + oldLength) / 4) * 4;
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + oldLength)));
  mutate(metadata);
  const encoded = new TextEncoder().encode(JSON.stringify(metadata)), offset = Math.ceil((16 + encoded.length) / 4) * 4;
  const result = new Uint8Array(offset + bytes.length - oldOffset);
  result.set(bytes.subarray(0, 16));
  new DataView(result.buffer).setUint32(4, encoded.length, true);
  result.set(encoded, 16); result.set(bytes.subarray(oldOffset), offset);
  return result;
}

describe('coverage-neutral schedule compilation', () => {
  it.each(['absent', 'blank'])('normalizes a single anonymous agency with %s agency_id columns', async variant => {
    const input = scheduleInput();
    input.files['agency.txt'] = variant === 'absent'
      ? 'agency_name,agency_url,agency_timezone\nMuni,https://sfmta.com,America/Los_Angeles\n'
      : 'agency_id,agency_name,agency_url,agency_timezone\n,Muni,https://sfmta.com,America/Los_Angeles\n';
    input.files['routes.txt'] = variant === 'absent'
      ? 'route_id,route_short_name,route_long_name,route_type\nR,N,Judah,0\n'
      : 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,,N,Judah,0\n';
    const first = await compiler.compileSchedule(input);
    const normalizedRef = 'tr:sfbay:sf511:agency:X19hbm9ueW1vdXNfYWdlbmN5X18';
    expect(first.shard.agencyTimezones).toEqual({ [normalizedRef]: 'America/Los_Angeles' });
    expect(first.shard.routes[0]!.agencyRef).toBe(normalizedRef);
    expect(first.shard.source.anonymousAgencyRef).toBe(normalizedRef);
    expect((await compiler.compileSchedule(input)).shardBytes).toEqual(first.shardBytes);
    // The same omission becomes ambiguous as soon as a second agency exists.
    input.files['agency.txt'] += variant === 'absent'
      ? 'Other,https://other.example,America/Los_Angeles\n'
      : 'B,Other,https://other.example,America/Los_Angeles\n';
    await expect(compiler.compileSchedule(input)).rejects.toThrow(/agency_id/);
  });

  it('requires route agency_id when multiple named agencies exist', async () => {
    const input = scheduleInput();
    input.files['agency.txt'] += 'B,Other,https://other.example,America/Los_Angeles\n';
    input.files['routes.txt'] = 'route_id,route_short_name,route_long_name,route_type\nR,N,Judah,0\n';
    await expect(compiler.compileSchedule(input)).rejects.toThrow(/agency_id/);
  });

  it.each([2, 3, 4, 5])('preserves type %i trip transfers across adjacent service days after midnight', async transferType => {
    const input = scheduleInput();
    input.files['calendar.txt'] = input.files['calendar.txt'].split('\n')[0]! + '\n';
    input.files['calendar_dates.txt'] = 'service_id,date,exception_type\nWK,20261018,1\nEX,20261019,1\n';
    input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('X,12:00:00,12:00:00', 'X,01:15:00,01:15:00');
    input.files['transfers.txt'] = `from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\nP2,P2,T,X,${transferType},120\n`;
    const previous = await compiler.compileSchedule({ ...input, window: { startDate: '20261018', endDate: '20261018' } });
    const next = await compiler.compileSchedule({ ...input, window: { startDate: '20261019', endDate: '20261019' } });
    expect(previous.shard.trips.map(t => t.providerId)).toEqual(['T']);
    expect(next.shard.trips.map(t => t.providerId)).toEqual(['X']);
    for (const result of [previous, next]) {
      expect(result.shard.transfers).toEqual([expect.objectContaining({ fromTripRef: 'tr:sfbay:sf511:trip:VA', toTripRef: 'tr:sfbay:sf511:trip:WA', transferType })]);
      expect(shards.decodeScheduleShard(result.shardBytes)).toEqual(result.shard);
    }
    expect(previous.shard.transferBoundaryTrips).toEqual([{ ref: 'tr:sfbay:sf511:trip:WA', providerId: 'X', routeRef: 'tr:sfbay:sf511:route:Ug', serviceId: 'EX', firstDepartureSeconds: 4500, lastArrivalSeconds: 4500 }]);
    expect(next.shard.transferBoundaryTrips).toEqual([{ ref: 'tr:sfbay:sf511:trip:VA', providerId: 'T', routeRef: 'tr:sfbay:sf511:route:Ug', serviceId: 'WK', firstDepartureSeconds: 90030, lastArrivalSeconds: 90600 }]);
    expect(previous.shard.source.sha256).toBe(next.shard.source.sha256);
    expect(next.shard.calendars.WK!.exceptions).toEqual({ '20261018': 1 });
  });
  it('round-trips numeric timetable rows without serializing them as JSON', async () => {
    expect(shards.decodeScheduleShard).toBeTypeOf('function');
    const { shard, shardBytes } = await compiler.compileSchedule(scheduleInput());
    expect(shards.decodeScheduleShard(shardBytes)).toEqual(shard);
    expect(shards.encodeScheduleShard(shards.decodeScheduleShard(shardBytes))).toEqual(shardBytes);
    expect(new TextDecoder().decode(shardBytes)).not.toContain('arrivalSeconds');
    // Header points to a 4-byte-aligned, little-endian numeric timetable.
    const view = new DataView(shardBytes.buffer);
    const offset = (16 + view.getUint32(4, true) + 3) & ~3;
    expect(view.getUint32(offset + 3 * 4, true)).toBe(90000);
    const untimed = scheduleInput();
    untimed.files['stop_times.txt'] = untimed.files['stop_times.txt'].replace('25:10:00,25:10:00', ',');
    const result = await compiler.compileSchedule(untimed);
    expect(shards.decodeScheduleShard(result.shardBytes).trips[0]!.stopTimes[1]!.arrivalSeconds).toBeNull();
  });

  it('rejects truncated, unsupported or corrupt binary shards', async () => {
    const { shardBytes } = await compiler.compileSchedule(scheduleInput());
    expect(() => shards.decodeScheduleShard(shardBytes.slice(0, -1))).toThrow(/shard/);
    const version = shardBytes.slice(); version[3] = 51;
    expect(() => shards.decodeScheduleShard(version)).toThrow(/shard/);
    const corrupt = shardBytes.slice();
    const view = new DataView(corrupt.buffer);
    const offset = (16 + view.getUint32(4, true) + 3) & ~3;
    view.setUint32(offset + 4, 999999, true);
    expect(() => shards.decodeScheduleShard(corrupt)).toThrow(/shard/);
  });

  it.each(['coverageId', 'feedId', 'window', 'source', 'agencyTimezones', 'routes', 'patterns', 'calendars', 'frequencies', 'blocks', 'transfers', 'pathways', 'transferBoundaryTrips'])('rejects missing %s binary metadata', async key => {
    const { shardBytes } = await compiler.compileSchedule(scheduleInput());
    expect(() => shards.decodeScheduleShard(mutateShardMetadata(shardBytes, metadata => { delete metadata[key]; }))).toThrow(/shard/);
  });

  it('rejects invalid trip metadata and trips without timetable rows', async () => {
    const { shard, shardBytes } = await compiler.compileSchedule(scheduleInput());
    expect(() => shards.decodeScheduleShard(mutateShardMetadata(shardBytes, metadata => {
      delete (metadata.trips as Record<string, unknown>[])[0]!.routeRef;
    }))).toThrow(/shard/);
    shard.trips[0]!.stopTimes = [];
    expect(() => shards.decodeScheduleShard(shards.encodeScheduleShard(shard))).toThrow(/shard/);
  });

  it.each([
    ['unknown trip index', 0, 0, 999], ['unknown headsign index', 0, 8, 999],
    ['repeated sequence', 1, 2, 10], ['arrival before previous departure', 1, 3, 89999],
    ['missing arrival only', 0, 3, 0xffffffff], ['departure before arrival', 0, 4, 89999],
  ])('rejects corrupt binary %s', async (_name, row, column, value) => {
    const { shardBytes } = await compiler.compileSchedule(scheduleInput());
    const view = new DataView(shardBytes.buffer), offset = Math.ceil((16 + view.getUint32(4, true)) / 4) * 4;
    view.setUint32(offset + (row * 9 + column) * 4, value, true);
    expect(() => shards.decodeScheduleShard(shardBytes)).toThrow(/shard/);
  });

  it('checks ordering across untimed intermediate rows', async () => {
    const input = scheduleInput();
    input.files['stop_times.txt'] += 'T,,,P1,15,0,0\n';
    const { shardBytes } = await compiler.compileSchedule(input);
    const view = new DataView(shardBytes.buffer), offset = Math.ceil((16 + view.getUint32(4, true)) / 4) * 4;
    view.setUint32(offset + (2 * 9 + 3) * 4, 89999, true);
    expect(() => shards.decodeScheduleShard(shardBytes)).toThrow(/shard/);
  });
  it('compiles ordered patterns, source agency timezones and times beyond midnight', async () => {
    expect(compiler.compileSchedule).toBeTypeOf('function');
    const result = await compiler.compileSchedule(scheduleInput());
    expect(result.manifest).toMatchObject({ schemaVersion: 2, coverageId: 'sfbay' });
    expect(result.shard.agencyTimezones).toEqual({ 'tr:sfbay:sf511:agency:QQ': 'America/Los_Angeles' });
    expect(result.shard.trips.find(t => t.providerId === 'T')).toMatchObject({
      ref: 'tr:sfbay:sf511:trip:VA', blockId: 'B', headsign: 'Ocean Beach', directionId: 0,
      wheelchairAccessible: 1, bikesAllowed: 2,
      stopTimes: [
        { stopRef: 'tr:sfbay:sf511:stop:UDE', sequence: 10, arrivalSeconds: 90000, departureSeconds: 90030, pickupType: 0, dropOffType: 1, timepoint: 1, headsign: '' },
        { stopRef: 'tr:sfbay:sf511:stop:UDI', sequence: 20, arrivalSeconds: 90600, departureSeconds: 90600, pickupType: 1, dropOffType: 0, timepoint: 1, headsign: '' },
      ],
    });
    expect(result.shard.patterns.some(p => p.stopRefs.join(',') === 'tr:sfbay:sf511:stop:UDE,tr:sfbay:sf511:stop:UDI')).toBe(true);
    expect(result.discovery.stops.map(s => s.providerId)).toEqual(['P1', 'P2', 'S']);
    expect(result.discovery).not.toHaveProperty('trips');
    expect(result.discovery.stopRoutes['tr:sfbay:sf511:stop:Uw']).toEqual(['tr:sfbay:sf511:route:Ug']);
    expect(SFBAY_COVERAGE.agencyTimezones).toEqual({});
  });

  it('preserves calendars, exception-only services, frequencies, transfers, pathways and provenance', async () => {
    const result = await compiler.compileSchedule(scheduleInput());
    expect(result.shard.calendars.WK).toMatchObject({ monday: true, exceptions: { '20261019': 2 } });
    expect(result.shard.calendars.EX).toMatchObject({ monday: false, exceptions: { '20261018': 1 } });
    expect(result.shard.frequencies).toEqual([{ tripRef: 'tr:sfbay:sf511:trip:VA', startSeconds: 90000, endSeconds: 93600, headwaySeconds: 600, exactTimes: 1 }]);
    expect(result.shard.blocks).toEqual({ B: ['tr:sfbay:sf511:trip:VA'] });
    expect(result.shard.transfers[0]).toMatchObject({ fromStopRef: 'tr:sfbay:sf511:stop:UDE', toStopRef: 'tr:sfbay:sf511:stop:UDI', fromTripRef: 'tr:sfbay:sf511:trip:VA', toTripRef: 'tr:sfbay:sf511:trip:WA', transferType: 2, minTransferSeconds: 120 });
    expect(result.shard.pathways[0]).toMatchObject({ id: 'PATH', fromStopRef: 'tr:sfbay:sf511:stop:Tg', toStopRef: 'tr:sfbay:sf511:stop:UDE', traversalSeconds: 45, bidirectional: true });
    expect(result.shard.stops.some(s => s.providerId === 'N')).toBe(true);
    expect(result.manifest.sources[0]).toMatchObject({ feedId: 'sf511', url: 'https://511.org/open-data/transit', retrievedAt: '2026-10-17T00:00:00Z', feedInfo: [{ feed_version: 'october', feed_start_date: '20261001', feed_end_date: '20261031' }] });
    expect(result.manifest.sources[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces identical bytes and keys despite GTFS row and column ordering', async () => {
    const first = await compiler.compileSchedule(scheduleInput());
    const input = scheduleInput();
    for (const name of Object.keys(input.files) as (keyof typeof input.files)[]) {
      const lines = input.files[name].trim().split('\n');
      input.files[name] = [lines[0], ...lines.slice(1).reverse()].map(line => line!.split(',').reverse().join(',')).join('\n') + '\n';
    }
    const second = await compiler.compileSchedule(input);
    expect(second.shardBytes).toEqual(first.shardBytes);
    expect(second.discoveryBytes).toEqual(first.discoveryBytes);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.manifest.shards[0]!.key).toMatch(/^artifacts\/sfbay\/v2\/sf511\/20261018-20261020\/[a-f0-9]{64}\.bin$/);
    const changed = scheduleInput();
    changed.files['stop_times.txt'] = changed.files['stop_times.txt'].replace('25:10:00,25:10:00', '25:11:00,25:11:00');
    expect((await compiler.compileSchedule(changed)).manifest.shards[0]!.key).not.toBe(first.manifest.shards[0]!.key);
  });

  it('keeps only trips whose services can run in the requested window', async () => {
    const input = scheduleInput();
    input.window = { startDate: '20261019', endDate: '20261019' };
    const result = await compiler.compileSchedule(input);
    expect(result.shard.trips).toEqual([]);
    expect(result.shard.frequencies).toEqual([]);
    expect(result.discovery.routes).toHaveLength(1);
  });

  it.each([
    ['missing stop', 'stop_times.txt', 'P2,20', 'MISSING,20', /unknown stop/],
    ['missing trip', 'stop_times.txt', 'X,12:', 'UNKNOWN,12:', /unknown trip/],
    ['missing route', 'trips.txt', 'R,WK,T', 'MISSING,WK,T', /unknown route/],
    ['missing service', 'trips.txt', 'R,WK,T', 'R,UNKNOWN,T', /unknown service/],
    ['missing agency', 'routes.txt', 'R,A,N', 'R,UNKNOWN,N', /unknown agency/],
    ['missing parent', 'stops.txt', '0,S', '0,UNKNOWN', /unknown parent/],
    ['missing transfer stop', 'transfers.txt', 'P1,P2', 'P1,UNKNOWN', /unknown stop/],
    ['missing pathway stop', 'pathways.txt', 'PATH,N,P1', 'PATH,N,UNKNOWN', /unknown stop/],
    ['missing frequency trip', 'frequencies.txt', 'T,25:', 'UNKNOWN,25:', /unknown trip/],
    ['backward time', 'stop_times.txt', '25:10:00,25:10:00', '24:59:00,24:59:00', /nonmonotonic/],
    ['departure before arrival', 'stop_times.txt', '25:00:00,25:00:30', '25:00:00,24:59:30', /nonmonotonic/],
    ['duplicate sequence', 'stop_times.txt', 'P2,20', 'P2,10', /duplicate stop_sequence/],
    ['invalid exception', 'calendar_dates.txt', '20261019,2', '20261019,3', /exception_type/],
    ['invalid timezone', 'agency.txt', 'America/Los_Angeles', 'Mars/Olympus', /timezone/],
  ])('rejects %s before producing artifacts', async (_name, file, from, to, error) => {
    const input = scheduleInput();
    const key = file as keyof typeof input.files;
    input.files[key] = input.files[key].replace(from, to);
    await expect(compiler.compileSchedule(input)).rejects.toThrow(error);
  });

  it('rejects duplicate IDs, undeclared feeds, invalid windows and credential-bearing source metadata', async () => {
    const duplicate = scheduleInput();
    duplicate.files['trips.txt'] += 'R,WK,T,Ocean Beach,0,B,1,2\n';
    await expect(compiler.compileSchedule(duplicate)).rejects.toThrow(/duplicate trip/);
    await expect(compiler.compileSchedule({ ...scheduleInput(), feedId: 'unknown' })).rejects.toThrow(/feed/);
    await expect(compiler.compileSchedule({ ...scheduleInput(), window: { startDate: '20260230', endDate: '20261020' } })).rejects.toThrow(/date/);
    await expect(compiler.compileSchedule({ ...scheduleInput(), source: { url: 'https://511.org/?api_key=secret', retrievedAt: '2026-10-17T00:00:00Z' } })).rejects.toThrow(/source URL/);
  });

  it('rejects credential-bearing feed_info links instead of storing them in artifacts', async () => {
    const input = scheduleInput();
    input.files['feed_info.txt'] = input.files['feed_info.txt'].replace('https://511.org,en', 'https://511.org?api_key=do-not-publish,en');
    await expect(compiler.compileSchedule(input)).rejects.toThrow(/feed_info URL/);
  });

  it('rejects transfers without their required endpoints or minimum time', async () => {
    const input = scheduleInput();
    input.files['transfers.txt'] = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nP1,,2,120\n';
    await expect(compiler.compileSchedule(input)).rejects.toThrow(/transfer endpoints/);
    input.files['transfers.txt'] = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nP1,P2,2,\n';
    await expect(compiler.compileSchedule(input)).rejects.toThrow(/min_transfer_time/);
  });
});

describe('MobilityData publication gate', () => {
  const summary = { validatorVersion: '8.0.1', validatedAt: '2026-10-17T00:00:00Z' };
  const allowlist = { coverageId: 'sfbay', warnings: [{ code: 'some_warning', reason: 'Fixture exception for a documented operator issue.', expires: '2026-11-01' }] };
  const report = (severity: string) => ({ summary, notices: [{ code: 'some_warning', severity, totalNotices: 1, sampleNotices: [] }] });

  it.each([
    ['missing-env', undefined], ['missing-file', null], ['malformed', '{'], ['wrong-shape', '{}'],
    ['empty-file', ''], ['execution-errors', '{"notices":[{"code":"thread_execution_error","severity":"ERROR","totalNotices":1,"sampleNotices":[{"exception":"java.lang.OutOfMemoryError","message":"Java heap space"}]}]}'],
    ['wrong-empty-wrapper', '[]'], ['extra-error-field', '{"notices":[],"errors":["failed"]}'],
  ])('publishes no manifest for %s system-error evidence', (name, content) => {
    const directory = mkdtempSync(join(tmpdir(), 'gtfs-system-gate-'));
    try {
      const reportPath = join(directory, 'report.json'), systemPath = join(directory, 'system_errors.json'), output = join(directory, 'output');
      writeFileSync(reportPath, JSON.stringify({ summary, notices: [] }));
      if (typeof content === 'string') writeFileSync(systemPath, content);
      const result = spawnSync('bun', ['scripts/build-sfbay-artifact.ts', output], { encoding: 'utf8', env: {
        ...process.env, SFBAY_GTFS_DIRECTORY: resolve('tests/fixtures/sfbay-gtfs'), SFBAY_VALIDATOR_REPORT: reportPath,
        SFBAY_VALIDATOR_SYSTEM_ERRORS: name === 'missing-env' ? '' : systemPath,
        SFBAY_SOURCE_RETRIEVED_AT: '2026-10-17T00:00:00Z', SFBAY_WINDOW_START: '20261018', SFBAY_WINDOW_END: '20261020',
      } });
      expect(result.status).not.toBe(0);
      expect(existsSync(join(output, 'manifest.json'))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('records validator provenance while allowing only documented unexpired warnings', async () => {
    expect(artifacts.validateMobilityDataReport).toBeTypeOf('function');
    expect(await artifacts.validateMobilityDataReport(JSON.stringify(report('WARNING')), allowlist, 'sfbay', '2026-10-17')).toMatchObject({
      name: 'MobilityData GTFS Validator', version: '8.0.1', validatedAt: summary.validatedAt, reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await artifacts.validateMobilityDataReport(JSON.stringify({ summary, notices: [] }), { coverageId: 'sfbay', warnings: [] }, 'sfbay', '2026-10-17')).toMatchObject({ version: '8.0.1' });
  });

  it('blocks errors, unlisted warnings, expired or unjustified exceptions and malformed reports', async () => {
    for (const [raw, list, date, error] of [
      [JSON.stringify(report('ERROR')), allowlist, '2026-10-17', /validator error/],
      [JSON.stringify(report('WARNING')), { coverageId: 'sfbay', warnings: [] }, '2026-10-17', /Unallowlisted/],
      [JSON.stringify(report('WARNING')), allowlist, '2026-11-01', /Expired/],
      [JSON.stringify(report('WARNING')), { coverageId: 'sfbay', warnings: [{ code: 'some_warning', reason: '', expires: '2026-11-01' }] }, '2026-10-17', /allowlist/],
      ['not JSON', allowlist, '2026-10-17', /report/],
      ['{}', allowlist, '2026-10-17', /report/],
      [JSON.stringify({ summary, notices: [{ code: 'bad', severity: 'UNKNOWN', totalNotices: 1 }] }), allowlist, '2026-10-17', /report/],
      [JSON.stringify({ summary, notices: [{ code: 'bad', severity: 'WARNING', totalNotices: -1 }] }), allowlist, '2026-10-17', /report/],
    ] as const) {
      await expect(artifacts.validateMobilityDataReport(raw, list, 'sfbay', date)).rejects.toThrow(error);
    }
  });

  it('builds byte-identical local artifacts and publishes no manifest when the validator gate fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtfs-build-test-'));
    try {
      const reportPath = join(directory, 'report.json');
      const systemErrorsPath = join(directory, 'system_errors.json');
      writeFileSync(reportPath, JSON.stringify({ summary, notices: [] }));
      writeFileSync(systemErrorsPath, '{"notices":[]}');
      const env = { ...process.env, SFBAY_GTFS_DIRECTORY: resolve('tests/fixtures/sfbay-gtfs'),
        SFBAY_VALIDATOR_SYSTEM_ERRORS: systemErrorsPath,
        SFBAY_VALIDATOR_REPORT: reportPath, SFBAY_SOURCE_RETRIEVED_AT: '2026-10-17T00:00:00Z',
        SFBAY_WINDOW_START: '20261018', SFBAY_WINDOW_END: '20261020' };
      const run = (output: string, overrides = {}) => spawnSync('bun', ['scripts/build-sfbay-artifact.ts', output], { env: { ...env, ...overrides }, encoding: 'utf8' });
      const first = join(directory, 'first'), second = join(directory, 'second');
      expect(run(first).status).toBe(0);
      expect(existsSync(join(first, 'manifest.json'))).toBe(true);
      expect(run(second).status).toBe(0);
      expect(readFileSync(join(first, 'manifest.json'))).toEqual(readFileSync(join(second, 'manifest.json')));
      const manifest = JSON.parse(readFileSync(join(first, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ discoveries: [{ feedId: 'sf511', key: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) }] });
      expect(manifest.validator).toMatchObject({ version: '8.0.1', reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/), systemErrorsSha256: expect.stringMatching(/^[a-f0-9]{64}$/), systemErrorsFormat: 'MobilityData notices' });
      for (const artifact of [...manifest.discoveries, ...manifest.shards]) {
        expect(readFileSync(join(first, artifact.key))).toEqual(readFileSync(join(second, artifact.key)));
      }
      for (const [name, text] of [['errors', JSON.stringify(report('ERROR'))], ['warnings', JSON.stringify(report('WARNING'))], ['malformed', '{']] as const) {
        writeFileSync(reportPath, text);
        const output = join(directory, name);
        expect(run(output).status).not.toBe(0);
        expect(existsSync(join(output, 'manifest.json'))).toBe(false);
      }
      expect(run(join(directory, 'missing'), { SFBAY_VALIDATOR_REPORT: '' }).status).not.toBe(0);
      expect(existsSync(join(directory, 'missing', 'manifest.json'))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('GTFS static primitives', () => {
  it('parses RFC 4180 rows with BOM, CRLF, commas, quotes, and newlines', () => {
    const csv = '\uFEFFstop_id,stop_name,desc\r\nA,"Market, Street","Line 1\r\nLine 2"\r\nB,"He said ""go""",\r\n';
    expect(parseGtfsCsv(csv)).toEqual([
      { stop_id: 'A', stop_name: 'Market, Street', desc: 'Line 1\r\nLine 2' },
      { stop_id: 'B', stop_name: 'He said "go"', desc: '' },
    ]);
  });

  it('rejects duplicate headers and rows with the wrong width', () => {
    expect(() => parseGtfsCsv('id,id\n1,2\n')).toThrow('Duplicate GTFS header');
    expect(() => parseGtfsCsv('id,name\n1\n')).toThrow('columns');
  });

  it('parses service times past midnight without normalizing them away', () => {
    expect(parseGtfsTime('00:00:00')).toEqual({ hours: 0, minutes: 0, seconds: 0, totalSeconds: 0 });
    expect(parseGtfsTime('25:30:05')).toEqual({ hours: 25, minutes: 30, seconds: 5, totalSeconds: 91805 });
    expect(() => parseGtfsTime('12:60:00')).toThrow('Invalid GTFS time');
  });

  it('preserves case-sensitive ids and percent-encodes resource segments', () => {
    expect(encodeTransitId('Ab:c /%')).toBe('Ab:c /%');
    expect(transitResourceUri('sfbay', 'stops', 'Ab:c /%')).toBe('transit://stops/sfbay/Ab%3Ac%20%2F%25');
  });

  it('maps standard and extended route types and rejects unknown values', () => {
    expect(routeTypeToMode(0)).toBe('tram');
    expect(routeTypeToMode(1)).toBe('subway');
    expect(routeTypeToMode(2)).toBe('rail');
    expect(routeTypeToMode(3)).toBe('bus');
    expect(routeTypeToMode(4)).toBe('ferry');
    expect(routeTypeToMode(5)).toBe('cable_tram');
    expect(routeTypeToMode(11)).toBe('trolleybus');
    expect(routeTypeToMode(100)).toBe('rail');
    expect(() => routeTypeToMode(99)).toThrow('Unsupported GTFS route_type');
  });

  it('builds byte-stable regional indexes and searches parent stations first', () => {
    const artifact = createStaticArtifact({
      region: 'sfbay',
      sourceVersion: 'fixture-v1',
      generatedAt: '2026-10-17T00:00:00.000Z',
      stops: [
        { id: 'platform-b', name: 'Montgomery B', latitude: 37.79, longitude: -122.4, parentStationId: 'station-1', locationType: 0 },
        { id: 'station-1', name: 'Montgomery Street', latitude: 37.79, longitude: -122.4, locationType: 1 },
        { id: 'platform-a', name: 'Montgomery A', latitude: 37.79, longitude: -122.4, parentStationId: 'station-1', locationType: 0 },
      ],
      routes: [{ id: 'route-z', shortName: 'N', longName: 'Judah', mode: 'tram', color: '0039A6' }],
      stopRoutes: { 'station-1': ['route-z', 'route-z'] },
    });

    expect(artifact.stops.map(stop => stop.id)).toEqual(['platform-a', 'platform-b', 'station-1']);
    expect(artifact.stopRoutes['station-1']).toEqual(['route-z']);
    expect(searchStops(artifact, 'montgomery', 2).map(stop => stop.id)).toEqual(['station-1', 'platform-a']);
    expect(JSON.stringify(artifact)).toBe(JSON.stringify(createStaticArtifact({
      region: 'sfbay', sourceVersion: 'fixture-v1', generatedAt: '2026-10-17T00:00:00.000Z',
      stops: [...artifact.stops].reverse(), routes: artifact.routes, stopRoutes: artifact.stopRoutes,
    })));
  });

  it('compiles the minimum GTFS tables into a deterministic query artifact', () => {
    const artifact = compileGtfsStatic({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,Market,37.7,-122.4,1,\nP1,Market Platform,37.7,-122.4,0,S1\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type,route_color\nR1,N,Judah,0,0039A6\n',
      'trips.txt': 'route_id,service_id,trip_id\nR1,WK,T1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,25:00:00,25:00:30,P1,1\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261001,20261031\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nWK,20261019,1\n',
    }, { sourceVersion: 'sha256:fixture', generatedAt: '2026-10-17T00:00:00.000Z' });

    expect(artifact.routes[0]).toMatchObject({ id: 'R1', mode: 'tram' });
    expect(artifact.stopRoutes).toEqual({ P1: ['R1'], S1: ['R1'] });
    expect(artifact.stopTimes).toEqual([expect.objectContaining({ tripId: 'T1', serviceId: 'WK', arrivalSeconds: 90000 })]);
    expect(artifact.calendars!.WK).toMatchObject({ monday: true, startDate: '20261001' });
  });

  it('can omit the regional timetable from the runtime query artifact', () => {
    const artifact = compileGtfsStatic({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nS1,Montgomery,37.789,-122.401\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR1,BART,Bay Area Rapid Transit,1\n',
      'trips.txt': 'route_id,service_id,trip_id\nR1,WK,T1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id\nT1,08:00:00,08:00:00,S1\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261001,20261231\n',
    }, {
      sourceVersion: 'test',
      generatedAt: '2026-10-17T00:00:00.000Z',
    }, { includeSchedule: false });

    expect(artifact.stopRoutes).toEqual({ S1: ['R1'] });
    expect(artifact).not.toHaveProperty('stopTimes');
    expect(artifact).not.toHaveProperty('calendars');
  });

  it('ignores unnamed GTFS pathway nodes that are not transit stops', () => {
    const artifact = compileGtfsStatic({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,Market,37.7,-122.4,1,\nP1,Market Platform,37.7,-122.4,0,S1\nN1,,37.7,-122.4,3,S1\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR1,N,Judah,0\n',
      'trips.txt': 'route_id,service_id,trip_id\nR1,WK,T1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,12:00:00,12:00:30,P1,1\n',
    }, { sourceVersion: 'sha256:pathways', generatedAt: '2026-10-17T00:00:00.000Z' });

    expect(artifact.stops.map(stop => stop.id)).toEqual(['P1', 'S1']);
  });

  it('keeps route associations but omits untimed stop-time rows from scheduled arrivals', () => {
    const artifact = compileGtfsStatic({
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,Market,37.7,-122.4,1,\nP1,Market Platform,37.7,-122.4,0,S1\nP2,Church Platform,37.8,-122.4,0,\n',
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR1,N,Judah,0\n',
      'trips.txt': 'route_id,service_id,trip_id\nR1,WK,T1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,,,P1,1\nT1,12:05:00,12:05:30,P2,2\n',
    }, { sourceVersion: 'sha256:untimed', generatedAt: '2026-10-17T00:00:00.000Z' });

    expect(artifact.stopRoutes).toEqual({ P1: ['R1'], P2: ['R1'], S1: ['R1'] });
    expect(artifact.stopTimes).toEqual([
      expect.objectContaining({ stopId: 'P2', arrivalSeconds: 43500, departureSeconds: 43530 }),
    ]);
  });
});
