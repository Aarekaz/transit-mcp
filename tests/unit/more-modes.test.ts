import { describe, expect, it } from 'vitest';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { NYC_COVERAGE } from '../../src/regions/nyc';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { composeManifest } from '../../src/transit/gtfs/static/compose';
import type { ArtifactManifestV2, DiscoveryIndex } from '../../src/transit/gtfs/static/schema';
import { decodeRealtimeFeed, type NormalizedRealtimeFeed } from '../../src/transit/gtfs/realtime/decode';
import { applyTripUpdates, matchTripInstance, type AppliedTripUpdates } from '../../src/transit/gtfs/realtime/trip-match';
import { combineApplied, routeByTimetable } from '../../src/transit/gtfs/realtime/region-feed-hub';
import { staticVersion } from '../../src/transit/gtfs/realtime/snapshot-store';
import { getRealtimeSource, getRealtimeSources, publishedKinds, sourceFeedIds } from '../../src/transit/gtfs/realtime/sources';
import { getStaticSource, isPrimaryFeed } from '../../src/transit/gtfs/refresh/policy';
import { sourceKeys } from '../../src/transit/gtfs/refresh/refresh';
import { planningFeedIds, getCoverage } from '../../src/transit/core/coverage';

const T = transit_realtime;

/** Metro-North style: internal trip_ids, the train number in trip_short_name, and train
 * 1299 leaving at 24:05 on two consecutive service days. */
async function metroNorth() {
  const compiled = await compileSchedule({ coverage: NYC_COVERAGE, feedId: 'mnr', window: { startDate: '20261019', endDate: '20261021' },
    source: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip', retrievedAt: '2026-10-19T00:00:00Z' },
    files: {
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\n1,Metro-North Railroad,http://www.mta.info/mnr,America/New_York\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n1,Grand Central,40.752998,-73.977056\n124,Stamford,41.046611,-73.542846\n',
      'routes.txt': 'route_id,agency_id,route_long_name,route_type\n3,1,New Haven,2\n',
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign,trip_short_name\n3,S19,S19+2394034+0,Grand Central,1299\n3,S20,S20+2394034+0,Grand Central,1299\n3,S19,S19+2390001+0,Grand Central,1300\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nS19+2394034+0,24:05:00,24:05:00,124,1\nS19+2394034+0,24:50:00,24:50:00,1,2\n' +
        'S20+2394034+0,24:05:00,24:05:00,124,1\nS20+2394034+0,24:50:00,24:50:00,1,2\nS19+2390001+0,09:00:00,09:00:00,124,1\nS19+2390001+0,09:45:00,09:45:00,1,2\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nS19,20261019,1\nS20,20261020,1\n',
    } });
  return { ...compiled, version: await staticVersion(compiled.manifest) };
}

describe('Metro-North train-number matching', () => {
  it('matches the one train of that number leaving at that civil time, across midnight', async () => {
    const f = await metroNorth();
    const context = { manifest: f.manifest, shards: [f.shard], version: f.version, feedId: 'mnr', tripMatching: 'train_number' as const };
    const update = (entityId: string, startDate: string, startTime: string) => ({ entityId, tripId: '3237829', routeId: '3', startDate, startTime,
      scheduleRelationship: 'SCHEDULED' as const, rawScheduleRelationship: 0, stops: [] });
    // 00:05 on the 20th is service day 19 at 24:05; the next night's train is a different trip.
    expect(matchTripInstance(update('1299', '20261020', '00:05:00'), context)).toMatchObject({ serviceDate: '20261019', trip: { providerId: 'S19+2394034+0' } });
    expect(matchTripInstance(update('1299', '20261021', '00:05:00'), context)).toMatchObject({ serviceDate: '20261020', trip: { providerId: 'S20+2394034+0' } });
    expect(matchTripInstance(update('1300', '20261019', '09:00:00'), context)).toMatchObject({ serviceDate: '20261019', trip: { providerId: 'S19+2390001+0' } });
    // The wrong time, an unknown number or no start time never guesses.
    expect(matchTripInstance(update('1299', '20261020', '00:06:00'), context)).toBeNull();
    expect(matchTripInstance(update('9999', '20261020', '00:05:00'), context)).toBeNull();
    expect(matchTripInstance({ ...update('1299', '20261020', '00:05:00'), startTime: undefined }, context)).toBeNull();
  });

  it('leaves a trip scheduled to start beyond the matched timetable out of the rate', async () => {
    const f = await metroNorth();
    const feed = decodeRealtimeFeed(T.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: 1 }, entity: [
      { id: '1300', tripUpdate: { trip: { tripId: 'x', routeId: '3', startDate: '20261019', startTime: '09:00:00' }, stopTimeUpdate: [{ stopId: '124', departure: { time: 1 } }] } },
    ] }).finish());
    const context = { manifest: f.manifest, shards: [f.shard], version: f.version, feedId: 'mnr', tripMatching: 'train_number' as const };
    const nine = Date.parse('2026-10-19T09:00:00-04:00') / 1000;
    expect((await applyTripUpdates(feed, { ...context, horizonEndSeconds: nine - 60 })).excluded.beyondWindow).toBe(1);
    expect((await applyTripUpdates(feed, { ...context, horizonEndSeconds: nine - 60 })).match.eligible).toBe(0);
    expect((await applyTripUpdates(feed, { ...context, horizonEndSeconds: nine + 60 })).match).toMatchObject({ eligible: 1, matched: 1 });
  });
});

describe('MTA railroad track extension', () => {
  const varint = (value: number) => { const out: number[] = []; while (value >= 0x80) { out.push((value % 0x80) | 0x80); value = Math.floor(value / 0x80); } out.push(value); return out; };
  const join = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap(part => [...part]));
  const field = (number: number, body: Uint8Array) => join(varint(number * 8 + 2), varint(body.length), body);
  const text = (value: string) => new TextEncoder().encode(value);
  function feedWithTracks(tracks: (string | undefined)[]) {
    const stops = tracks.map((track, index) => field(2, join(T.TripUpdate.StopTimeUpdate.encode({ stopId: `S${index}`, departure: { time: 100 + index } }).finish(),
      track === undefined ? [] : field(1005, join(field(1, text(track)), field(2, text('On-Time')))))));
    const update = join(field(1, T.TripDescriptor.encode({ tripId: 'GO1', startDate: '20261019' }).finish()), ...stops);
    return join(field(1, T.FeedHeader.encode({ gtfsRealtimeVersion: '2.0', timestamp: 1 }).finish()), field(2, join(field(1, text('e1')), field(3, update))));
  }
  it('reads each stop’s track only when asked, and ignores implausible values', () => {
    const bytes = feedWithTracks(['4', undefined, '<b>']);
    expect(decodeRealtimeFeed(bytes, { mtaRailroad: true }).tripUpdates.map(row => row.track)).toEqual(['4', undefined, undefined]);
    expect(decodeRealtimeFeed(bytes).tripUpdates.map(row => row.track)).toEqual([undefined, undefined, undefined]);
  });
});

describe('one realtime document for several timetables', () => {
  const discovery = (feedId: string, tripProviderIds: string[]) => ({ feedId, tripProviderIds: [...tripProviderIds].sort() }) as unknown as DiscoveryIndex;
  const feed = (tripIds: string[]): NormalizedRealtimeFeed => ({ producerTimestampSeconds: 1, warnings: [], alerts: [],
    trips: tripIds.map(tripId => ({ entityId: `e-${tripId}`, tripId, scheduleRelationship: 'SCHEDULED', rawScheduleRelationship: 0, stops: [] })),
    tripUpdates: tripIds.map(tripId => ({ entityId: `e-${tripId}`, tripId, stopId: 'S' })),
    vehicles: tripIds.map(tripId => ({ entityId: `v-${tripId}`, tripId, stopId: 'S' })) });
  it('sends each trip and vehicle to the timetable that lists it; unlisted ones to the first', () => {
    const routed = routeByTimetable(feed(['bx-1', 'b-1', 'b-2', 'ghost']), [discovery('mta_bus_bx', ['bx-1', 'bx-2']), discovery('mta_bus_b', ['b-2', 'b-1'])]);
    expect(routed.map(part => part.trips.map(trip => trip.tripId))).toEqual([['bx-1', 'ghost'], ['b-1', 'b-2']]);
    expect(routed.map(part => part.tripUpdates.map(row => row.tripId))).toEqual([['bx-1', 'ghost'], ['b-1', 'b-2']]);
    expect(routed.map(part => part.vehicles.map(vehicle => vehicle.tripId))).toEqual([['bx-1', 'ghost'], ['b-1', 'b-2']]);
  });
  it('judges schedule identity on the combined totals, never one borough', async () => {
    const version = { artifactVersion: 'a'.repeat(64), sourceVersions: {} };
    const result = (eligible: number, matched: number): AppliedTripUpdates => ({ version, trips: [], stopUpdates: [], match: { eligible, matched, rate: eligible ? matched / eligible : 1 },
      excluded: { nonRevenue: 0, invalidExtras: 0, unrepresentableAdded: 0, beyondWindow: 0 }, degraded: false, warnings: [] });
    // 2 of 10 in one borough would fail alone; 92 of 100 overall passes a 0.5 gate.
    expect(combineApplied([result(10, 2), result(90, 90)], 0.5, version)).toMatchObject({ match: { eligible: 100, matched: 92 }, degraded: false });
    expect(combineApplied([result(30, 5), result(30, 5)], 0.5, version)).toMatchObject({ degraded: true, warnings: ['SCHEDULE_REALTIME_MISMATCH'] });
    expect(combineApplied([], 0.5, version)).toMatchObject({ stopUpdates: [], degraded: false });
  });
});

describe('composing a coverage from several feeds', () => {
  const manifest = (feedId: string, extra: Partial<ArtifactManifestV2> = {}): ArtifactManifestV2 => ({ schemaVersion: 2, coverageId: 'nyc',
    sources: [{ feedId, url: 'https://example.org/gtfs.zip', retrievedAt: '2026-10-19T00:00:00Z', sha256: feedId.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a'), feedInfo: [] }],
    agencyTimezones: { [`tr:nyc:${feedId}:agency:QQ`]: 'America/New_York' },
    discoveries: [{ feedId, key: `artifacts/nyc/v2/${feedId}/discovery.json`, sha256: 'b'.repeat(64), byteLength: 1 }],
    shards: [{ feedId, key: `artifacts/nyc/v2/${feedId}/x.bin`, sha256: 'c'.repeat(64), byteLength: 1, window: { startDate: '20261019', endDate: '20261019' }, maxStopTimeSeconds: 1 }], ...extra });
  const evidence = { name: 'MobilityData GTFS Validator' as const, version: '8.0.1', reportSha256: 'd'.repeat(64), validatedAt: '2026-10-19T00:00:00Z', systemErrorsSha256: 'e'.repeat(64), systemErrorsFormat: 'MobilityData notices' as const };
  it('replaces only the refreshed feed and keeps every feed’s validator evidence', () => {
    const subway = manifest('mta_subway', { validator: evidence });
    const both = composeManifest(subway, manifest('lirr', { validator: { ...evidence, reportSha256: 'f'.repeat(64) } }));
    expect(both.sources.map(source => source.feedId)).toEqual(['lirr', 'mta_subway']);
    expect(both).not.toHaveProperty('validator');
    expect(Object.keys(both.validators!)).toEqual(['mta_subway', 'lirr']);
    // An edge refresh carries no validator evidence: that feed's entry goes, the others stay.
    const refreshed = composeManifest(both, manifest('lirr', { shards: [] }));
    expect(refreshed.shards.map(shard => shard.feedId)).toEqual(['mta_subway']);
    expect(Object.keys(refreshed.validators!)).toEqual(['mta_subway']);
    expect(composeManifest(null, subway)).toBe(subway);
    expect(() => composeManifest(subway, { ...manifest('lirr'), coverageId: 'dc' })).toThrow(/coverage/);
    expect(() => composeManifest(subway, { ...manifest('lirr'), sources: [...manifest('lirr').sources, ...manifest('mnr').sources] })).toThrow(/exactly one feed/);
  });
});

describe('feed configuration', () => {
  it('gives every feed its own realtime source, buses no planning, and primaries their old keys', () => {
    expect(getRealtimeSources('nyc').map(source => source.policy.namespace)).toEqual(['nyc:mta', 'nyc:lirr', 'nyc:mnr', 'nyc:mta_bus',
      'nyc:mta_bus_bx', 'nyc:mta_bus_b', 'nyc:mta_bus_m', 'nyc:mta_bus_q', 'nyc:mta_bus_si', 'nyc:mta_bus_co']);
    // The Bus Time relay makes every request and publishes alerts; each borough matches its own trips.
    const relay = getRealtimeSources('nyc').find(source => source.policy.namespace === 'nyc:mta_bus')!;
    expect([...publishedKinds(relay)]).toEqual(['service_alerts']);
    const queens = getRealtimeSources('nyc').find(source => source.policy.namespace === 'nyc:mta_bus_q')!;
    expect([...publishedKinds(queens)].sort()).toEqual(['trip_updates', 'vehicle_positions']);
    expect(queens.policy).toMatchObject({ feedId: 'mta_bus_q', relayFrom: relay.policy.relayTo!.prefix });
    expect(sourceFeedIds(queens.policy)).toEqual(['mta_bus_q']);
    expect(getRealtimeSources('dc').map(source => source.policy.namespace)).toEqual(['dc:wmata', 'dc:wmata_bus']);
    expect(sourceFeedIds(getRealtimeSource('nyc', 'mta_bus_q')!.policy)).toEqual(['mta_bus_bx', 'mta_bus_b', 'mta_bus_m', 'mta_bus_q', 'mta_bus_si', 'mta_bus_co']);
    expect(getRealtimeSource('nyc', 'mta_bus_q')!.policy.auth).toEqual({ kind: 'query_token', secretEnv: 'MTA_BUS_API_KEY', param: 'key' });
    expect(planningFeedIds(getCoverage('dc')!)).toEqual(['wmata']);
    expect(planningFeedIds(getCoverage('nyc')!)).toEqual(['mta_subway', 'lirr', 'mnr']);
    expect([isPrimaryFeed('nyc', 'mta_subway'), isPrimaryFeed('nyc', 'lirr')]).toEqual([true, false]);
    expect(sourceKeys('nyc', 'mta_subway').state).toBe('sources/nyc/state.json');
    expect(sourceKeys('nyc', 'lirr').state).toBe('sources/nyc/lirr/state.json');
    expect(sourceKeys('dc', 'wmata_bus').work('abc').prefix).toBe('work/dc/wmata_bus/abc/');
    expect(getStaticSource('dc', 'wmata_bus')).toMatchObject({ conditional: true, bandSeconds: 3600 });
  });
});
