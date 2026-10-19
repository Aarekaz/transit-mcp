import { transit_realtime } from 'gtfs-realtime-bindings';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMetroMcpServer } from '../../src/mcp/server';
import { getCoverage } from '../../src/transit/core/coverage';
import { formatEntityRef } from '../../src/transit/core/refs';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { partitionSchedule } from '../../src/transit/gtfs/static/partition';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import { RegionFeedHub } from '../../src/transit/gtfs/realtime/region-feed-hub';
import type { GtfsScheduleFiles } from '../../src/transit/gtfs/static/schema';
import type { Env } from '../../src/types';
import { createMockEnv } from '../setup';
import { memoryStorage } from './realtime-fixture';
import { modernMcpRequest, readMcpResponse } from './mcp-request';

/** Monday. Timetables are synthetic but use the official NYCT and WMATA identifier
 * formats (platform stop IDs, NYCT schedule-prefixed trip IDs, WMATA PF_ platforms). */
export const SERVICE_DATE = '20261019';
export const NOW = '2026-10-19T08:59:00-04:00';
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const civil = (time: string, date = '2026-10-19') => Date.parse(`${date}T${time}-04:00`) / 1000;

const calendar = 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWeekday,1,1,1,1,1,0,0,20261001,20261031\n';
const NYC_FILES: GtfsScheduleFiles = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nMTA NYCT,MTA New York City Transit,http://www.mta.info,America/New_York\n',
  'stops.txt': ['stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
    '127,Times Sq-42 St,40.75529,-73.987495,1,', '127S,Times Sq-42 St,40.75529,-73.987495,,127',
    '128,34 St-Penn Station,40.750373,-73.991057,1,', '128S,34 St-Penn Station,40.750373,-73.991057,,128',
    '129,28 St,40.747215,-73.993365,1,', '129S,28 St,40.747215,-73.993365,,129',
    '130,23 St,40.744081,-73.995657,1,', '130S,23 St,40.744081,-73.995657,,130',
    '131,18 St,40.74104,-73.997871,1,', '131S,18 St,40.74104,-73.997871,,131',
    '132,14 St,40.737826,-74.000201,1,', '132S,14 St,40.737826,-74.000201,,132',
    'D19,14 St,40.738228,-73.996209,1,', 'D19S,14 St,40.738228,-73.996209,,D19'].join('\n') + '\n',
  'routes.txt': 'agency_id,route_id,route_short_name,route_long_name,route_type\nMTA NYCT,1,1,Broadway - 7 Avenue Local,1\nMTA NYCT,2,2,7 Avenue Express,1\nMTA NYCT,F,F,Queens Blvd Express/6 Av Local,1\n',
  'trips.txt': ['route_id,trip_id,service_id,trip_headsign,direction_id',
    '1,AFA25GEN-1092-Weekday-00_054800_1..S03R,Weekday,South Ferry,1',
    '1,AFA25GEN-1092-Weekday-00_055400_1..S03R,Weekday,South Ferry,1',
    '2,AFA25GEN-2092-Weekday-00_054900_2..S01R,Weekday,Flatbush Av-Brooklyn College,1',
    // Overnight: a service-day-19 trip running after civil midnight on the 20th.
    '1,AFA25GEN-1092-Weekday-00_146400_1..S03R,Weekday,South Ferry,1',
    'F,BFA25GEN-F092-Weekday-00_054000_F..S69R,Weekday,Coney Island-Stillwell Av,1'].join('\n') + '\n',
  'stop_times.txt': ['trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    ...['127S', '128S', '129S', '130S', '131S', '132S'].map((stop, index) => `AFA25GEN-1092-Weekday-00_054800_1..S03R,09:${String(8 + index * 2).padStart(2, '0')}:00,09:${String(8 + index * 2).padStart(2, '0')}:00,${stop},${index + 1}`),
    ...['127S', '128S', '129S', '130S', '131S', '132S'].map((stop, index) => `AFA25GEN-1092-Weekday-00_055400_1..S03R,09:${String(14 + index * 2).padStart(2, '0')}:00,09:${String(14 + index * 2).padStart(2, '0')}:00,${stop},${index + 1}`),
    'AFA25GEN-2092-Weekday-00_054900_2..S01R,09:09:00,09:09:00,127S,1', 'AFA25GEN-2092-Weekday-00_054900_2..S01R,09:11:00,09:11:00,128S,2',
    'AFA25GEN-2092-Weekday-00_054900_2..S01R,09:15:00,09:15:00,132S,3',
    ...['127S', '128S', '129S', '130S', '131S', '132S'].map((stop, index) => `AFA25GEN-1092-Weekday-00_146400_1..S03R,24:${String(24 + index * 2).padStart(2, '0')}:00,24:${String(24 + index * 2).padStart(2, '0')}:00,${stop},${index + 1}`),
    'BFA25GEN-F092-Weekday-00_054000_F..S69R,09:00:00,09:00:00,D19S,1', 'BFA25GEN-F092-Weekday-00_054000_F..S69R,09:30:00,09:30:00,132S,2'].join('\n') + '\n',
  'calendar.txt': calendar,
  'transfers.txt': 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\n132,132,2,180\n',
};
const DC_FILES: GtfsScheduleFiles = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\n1,WMATA,http://www.wmata.com,America/New_York\n',
  'stops.txt': ['stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
    'STN_A03,Dupont Circle,38.909499,-77.04362,1,', 'PF_A03_C,Dupont Circle,38.909499,-77.04362,0,STN_A03',
    'STN_A02,Farragut North,38.903192,-77.039766,1,', 'PF_A02_C,Farragut North,38.903192,-77.039766,0,STN_A02',
    'STN_A01,Metro Center,38.898303,-77.028099,1,', 'PF_A01_C,Metro Center,38.898303,-77.028099,0,STN_A01'].join('\n') + '\n',
  'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nRED,1,R,Red,1\nSHUTTLE,1,SHUTTLE,,3\n',
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id\nRED,Weekday,14362694_20741,Glenmont,0\nRED,Weekday,14362719_20741,Glenmont,0\nSHUTTLE,Weekday,16568_20744,Foggy Bottom-GWU LCL,0\n',
  'stop_times.txt': ['trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    '14362694_20741,09:02:00,09:02:00,PF_A03_C,1', '14362694_20741,09:04:00,09:04:00,PF_A02_C,2', '14362694_20741,09:06:00,09:06:00,PF_A01_C,3',
    '14362719_20741,09:12:00,09:12:00,PF_A03_C,1', '14362719_20741,09:14:00,09:14:00,PF_A02_C,2', '14362719_20741,09:16:00,09:16:00,PF_A01_C,3',
    // GTFS-unusable single-stop placeholder, as published by WMATA.
    '16568_20744,09:05:00,09:05:00,PF_A02_C,1'].join('\n') + '\n',
  'calendar.txt': calendar,
};

export async function bandedArtifact(coverageId: 'dc' | 'nyc', db = memoryStorage()) {
  const coverage = getCoverage(coverageId)!;
  const feedId = coverageId === 'dc' ? 'wmata' : 'mta_subway';
  const compiled = await compileSchedule({ coverage, feedId, files: coverageId === 'dc' ? DC_FILES : NYC_FILES,
    window: { startDate: '20261018', endDate: '20261021' },
    source: { url: coverageId === 'dc' ? 'https://api.wmata.com/gtfs/rail-gtfs-static.zip' : 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip', retrievedAt: '2026-10-18T00:00:00Z' } });
  const partitioned = await partitionSchedule(compiled, 3 * 3600);
  for (const { key, bytes } of partitioned.objects) await db.bucket.put(key, bytes);
  const version = await new StaticArtifactStore(db.bucket, coverageId).publish(partitioned.manifest);
  return { db, coverageId, feedId, compiled, partitioned, version, ref: (kind: 'stop' | 'route' | 'trip' | 'agency', id: string) => formatEntityRef({ coverage: coverageId, feed: feedId, kind, id }) };
}

type Entity = transit_realtime.IFeedEntity;
export const feedBytes = (timestamp: number, entity: Entity[]) =>
  transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp }, entity })).finish();
export function nyctTrip(tripId: string, routeId: string, stops: [stopId: string, time: number][], startTime = '09:08:00', startDate = SERVICE_DATE): Entity {
  return { id: tripId, tripUpdate: { trip: { tripId, routeId, startDate, startTime }, stopTimeUpdate: stops.map(([stopId, time]) => ({ stopId, arrival: { time }, departure: { time } })) } };
}

/** Upstream documents by URL path; any path absent from `documents` answers 503. */
export function upstream(documents: Record<string, Uint8Array | (() => Uint8Array)>) {
  const requests: Request[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request);
    const path = decodeURIComponent(new URL(request.url).pathname);
    const key = Object.keys(documents).find(suffix => path.endsWith(suffix));
    if (!key) return new Response(null, { status: 503 });
    const value = documents[key]!;
    return new Response(typeof value === 'function' ? value() : value, { headers: { 'content-type': 'application/x-protobuf' } });
  };
  return { fetcher, requests };
}

/** The real coordinator, addressed by name through a namespace stub. */
export function wireHub(env: Env, db: ReturnType<typeof memoryStorage>, namespace: string) {
  const hubs = new Map<string, RegionFeedHub>();
  env.REGION_FEED_HUB = { idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => ({ fetch: (request: string | Request) => {
      const hub = hubs.get(id.toString());
      return hub ? hub.fetch(typeof request === 'string' ? new Request(request) : request) : Promise.resolve(new Response(null, { status: 409 }));
    } }) } as unknown as DurableObjectNamespace;
  const hub = new RegionFeedHub({ id: { toString: () => namespace }, storage: db.storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, env);
  hubs.set(namespace, hub);
  return hub;
}

export function liveEnv(db: ReturnType<typeof memoryStorage>, overrides: Partial<Env> = {}) {
  return createMockEnv({ TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: JSON.stringify({ dc: 'on', nyc: 'on' }), WMATA_API_KEY: 'test-wmata-key', ...overrides });
}

export async function callTool(env: Env, name: string, args: Record<string, unknown>) {
  const handler = createMcpHandler(ctx => createMetroMcpServer({ env, era: ctx.era, toolRequest: { name, arguments: args } }));
  try {
    const response = await handler.fetch(await modernMcpRequest('tools/call', { name, arguments: args }));
    const messages = await readMcpResponse(response);
    const envelope = messages[0] as { error?: unknown; result: { isError?: boolean; structuredContent: Record<string, any> } };
    if (envelope.error) throw new Error(JSON.stringify(envelope.error));
    return envelope.result;
  } finally { await handler.close(); }
}
