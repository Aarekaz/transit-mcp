import { describe, expect, it, vi } from 'vitest';
import { NYC_COVERAGE } from '../../src/regions/nyc';
import { loadData, loadTripIds, mayBeTripId } from '../../src/mcp/tools/global/shared';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { composeManifest } from '../../src/transit/gtfs/static/compose';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import type { MetroMcpContext } from '../../src/mcp/context';
import { NYC_FILES } from '../helpers/dc-nyc-realtime';
import { memoryStorage } from '../helpers/realtime-fixture';

const window = { startDate: '20261019', endDate: '20261021' };
const source = (url: string) => ({ url, retrievedAt: '2026-10-19T00:00:00Z' });

/** A two-feed New York coverage (subway and Metro-North), published to a memory bucket. */
async function coverage({ places = true } = {}) {
  const subway = await compileSchedule({ coverage: NYC_COVERAGE, feedId: 'mta_subway', window, source: source('https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip'),
    files: NYC_FILES });
  const railroad = await compileSchedule({ coverage: NYC_COVERAGE, feedId: 'mnr', window, source: source('https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip'),
    files: {
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\n1,Metro-North Railroad,http://www.mta.info/mnr,America/New_York\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n1,Grand Central,40.752998,-73.977056\n124,Stamford,41.046611,-73.542846\n',
      'routes.txt': 'route_id,agency_id,route_long_name,route_type\n3,1,New Haven,2\n',
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign\n3,S19,T1,Grand Central\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,09:00:00,09:00:00,124,1\nT1,09:45:00,09:45:00,1,2\n',
      'calendar_dates.txt': 'service_id,date,exception_type\nS19,20261019,1\n',
    } });
  const db = memoryStorage();
  for (const compiled of [subway, railroad]) {
    db.objects.set(compiled.manifest.discoveries[0]!.key, compiled.discoveryBytes);
    if (places) db.objects.set(compiled.manifest.places![0]!.key, compiled.placesBytes);
    db.objects.set(compiled.manifest.shards[0]!.key, compiled.shardBytes);
  }
  await new StaticArtifactStore(db.bucket, 'nyc').publish(composeManifest(subway.manifest, railroad.manifest));
  const reads: string[] = [];
  const bucket = new Proxy(db.bucket, { get: (target, key) => key !== 'get' ? Reflect.get(target, key)
    : (name: string, ...rest: unknown[]) => { reads.push(name); return (target.get as (...args: unknown[]) => unknown)(name, ...rest); } });
  const context = { env: { TRANSIT_ARTIFACTS: bucket, TRANSIT_COVERAGE_MODES: '{"nyc":"on"}' } } as unknown as MetroMcpContext;
  return { subway, railroad, db, reads, context };
}

describe('loading a coverage', () => {
  it('reads every feed index of a coverage at once, not one round trip after another', async () => {
    const f = await coverage();
    const indexes = new Set([f.subway, f.railroad].map(compiled => compiled.manifest.places![0]!.key));
    let open = 0, most = 0;
    const bucket = new Proxy(f.db.bucket, { get: (target, key) => key !== 'get' ? Reflect.get(target, key) : async (name: string, ...rest: unknown[]) => {
      if (!indexes.has(name)) return (target.get as (...args: unknown[]) => unknown)(name, ...rest);
      open++; most = Math.max(most, open);
      if (open < indexes.size) await new Promise<void>(resolve => setTimeout(resolve, 200));
      open--;
      return (target.get as (...args: unknown[]) => unknown)(name, ...rest);
    } });
    const data = await loadData({ env: { TRANSIT_ARTIFACTS: bucket, TRANSIT_COVERAGE_MODES: '{"nyc":"on"}' } } as unknown as MetroMcpContext, 'nyc', new AbortController().signal);
    expect(data?.indexes.map(index => index.feedId).sort()).toEqual(['mnr', 'mta_subway']);
    expect(most).toBe(2);
  });

  it('reads each feed\'s places index, leaving its trip IDs until a trip is looked up', async () => {
    const f = await coverage();
    const data = (await loadData(f.context, 'nyc', new AbortController().signal))!;
    expect(f.reads.filter(key => key.includes('/places/'))).toHaveLength(2);
    expect(f.reads.filter(key => key.includes('/discovery/'))).toEqual([]);
    expect(data.indexes.every(index => index.tripProviderIds === undefined)).toBe(true);
    // Stops and routes are all there, the same as in the full index.
    const subway = data.indexes.find(index => index.feedId === 'mta_subway')!;
    expect(subway.stops).toEqual(f.subway.discovery.stops);
    expect(subway.stopRoutes).toEqual(f.subway.discovery.stopRoutes);
    // Asking for one feed's trips reads that feed's discovery index only.
    await loadTripIds(data, ['mnr']);
    expect(f.reads.filter(key => key.includes('/discovery/'))).toEqual([f.railroad.manifest.discoveries[0]!.key]);
  });

  it('falls back to the discovery index when a places index is missing', async () => {
    const f = await coverage({ places: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = (await loadData(f.context, 'nyc', new AbortController().signal))!;
    expect(data.indexes.map(index => index.tripProviderIds?.length)).toEqual([1, 5]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('places_fallback'));
    warn.mockRestore();
  });

  it('treats a one-word query with a digit as a possible trip ID, and names as names', () => {
    expect(['AFA25GEN-1092-Weekday-00_054800_1..S03R', 'S19+2394034+0', '1299'].every(mayBeTripId)).toBe(true);
    expect(['Times Sq-42 St', 'Grand Central', 'Embarcadero', '14 St on the 1'].some(mayBeTripId)).toBe(false);
  });
});
