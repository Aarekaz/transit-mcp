import { describe, expect, it } from 'vitest';
import { NYC_COVERAGE } from '../../src/regions/nyc';
import { loadData } from '../../src/mcp/tools/global/shared';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { composeManifest } from '../../src/transit/gtfs/static/compose';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import type { MetroMcpContext } from '../../src/mcp/context';
import { NYC_FILES } from '../helpers/dc-nyc-realtime';
import { memoryStorage } from '../helpers/realtime-fixture';

const window = { startDate: '20261019', endDate: '20261021' };
const source = (url: string) => ({ url, retrievedAt: '2026-10-19T00:00:00Z' });

describe('loading a coverage', () => {
  it('reads every feed index of a coverage at once, not one round trip after another', async () => {
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
      db.objects.set(compiled.manifest.shards[0]!.key, compiled.shardBytes);
    }
    await new StaticArtifactStore(db.bucket, 'nyc').publish(composeManifest(subway.manifest, railroad.manifest));
    // A bucket that holds every discovery read open until both have been asked for.
    const discoveries = new Set([subway, railroad].map(compiled => compiled.manifest.discoveries[0]!.key));
    let open = 0, most = 0;
    const waiting: (() => void)[] = [];
    const bucket = new Proxy(db.bucket, { get: (target, key) => key !== 'get' ? Reflect.get(target, key) : async (name: string, ...rest: unknown[]) => {
      if (!discoveries.has(name)) return (target.get as (...args: unknown[]) => unknown)(name, ...rest);
      open++; most = Math.max(most, open);
      if (open < discoveries.size) await new Promise<void>(resolve => { waiting.push(resolve); setTimeout(resolve, 200); });
      else waiting.splice(0).forEach(resolve => resolve());
      open--;
      return (target.get as (...args: unknown[]) => unknown)(name, ...rest);
    } });
    const context = { env: { TRANSIT_ARTIFACTS: bucket, TRANSIT_COVERAGE_MODES: '{"nyc":"on"}' } } as unknown as MetroMcpContext;
    const data = await loadData(context, 'nyc', new AbortController().signal);
    expect(data?.indexes.map(index => index.feedId).sort()).toEqual(['mnr', 'mta_subway']);
    expect(most).toBe(2);
  });
});
