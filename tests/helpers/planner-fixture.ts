import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { SFBAY_COVERAGE } from '../../src/regions/sfbay';
import { formatTripInstanceRef, type TransitRef } from '../../src/transit/core/refs';
import { staticVersion } from '../../src/transit/gtfs/realtime/snapshot-store';
import type { CompileScheduleInput } from '../../src/transit/gtfs/static/schema';
import type { Itinerary, TransitLeg, ValidationSource } from '../../src/transit/planner/types';

export const ref = (kind: 'stop' | 'trip' | 'route', id: string): TransitRef => `tr:sfbay:sf511:${kind}:${btoa(id).replaceAll('=', '')}`;
export const at = (time: string) => `2026-10-19T${time}-07:00`;
export function plannerInput(): CompileScheduleInput {
  return {
    coverage: SFBAY_COVERAGE, feedId: 'sf511', window: { startDate: '20260101', endDate: '20261231' },
    source: { url: 'https://511.org/open-data/transit', retrievedAt: '2026-10-18T00:00:00Z' },
    files: {
      'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA,Muni,https://sfmta.com,America/Los_Angeles\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,Origin,37,-122\nB,Interchange,37.02,-122\nC,Destination,37.04,-122\nD,Nearby platform,37.0205,-122\n',
      'routes.txt': 'route_id,agency_id,route_short_name,route_type\nR,A,R,0\nS,A,S,0\n',
      'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,block_id\nR,D,T,Destination,0,\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT,09:00:00,09:00:00,A,1,0,0\nT,09:10:00,09:10:00,B,2,0,0\nT,09:20:00,09:20:00,C,3,0,0\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nD,1,1,1,1,1,1,1,20260101,20261231\n',
    },
  };
}
export function transferInput() {
  const input = plannerInput();
  input.files['trips.txt'] = input.files['trips.txt'].replace('Destination,0,', 'Interchange,0,block') + 'S,D,U,Destination,1,block\n';
  input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('T,09:20:00,09:20:00,C,3,0,0\n', '') +
    'U,09:12:00,09:12:00,B,1,0,0\nU,09:25:00,09:25:00,C,2,0,0\n';
  return input;
}
export async function plannerFixture(input = plannerInput(), windows = [input.window]) {
  const compiledWindows = await Promise.all(windows.map(window => compileSchedule({ ...input, window })));
  const compiled = compiledWindows[0]!;
  const manifest = { ...compiled.manifest, shards: compiledWindows.flatMap(item => item.manifest.shards) };
  const reads: string[] = [];
  const query = {
    manifest, origin: ref('stop', 'A'), destination: ref('stop', 'C'),
    departAt: at('08:59:00'), now: at('08:59:00'), windowSeconds: 7200, maxWalkMetres: 0,
    readShard: async (key: string) => {
      reads.push(key);
      const selected = compiledWindows.find(item => item.manifest.shards[0]!.key === key);
      if (!selected) throw new Error('Unexpected shard read');
      return selected.shardBytes;
    },
  };
  const source: ValidationSource = { manifest, shards: compiledWindows.map(item => item.shard), now: query.now };
  const version = await staticVersion(manifest);
  return { compiled, query, source, reads, version };
}

export function colocatedInput() {
  const input = plannerInput();
  for (let index = 0; index < 7; index++) input.files['stops.txt'] += `E${index},Colocated ${index},37,-122\n`;
  input.files['trips.txt'] += 'R,D,U,Destination,0,\n';
  input.files['stop_times.txt'] += 'U,09:05:00,09:05:00,E6,1,0,0\nU,09:25:00,09:25:00,C,2,0,0\n';
  return input;
}

export function pathwayInput() {
  const input = transferInput();
  input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',') + 'R,D,L,Late,0,\n';
  input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('09:12:00,B', '09:12:00,D') +
    'L,36:00:00,36:00:00,B,1,0,0\nL,36:10:00,36:10:00,C,2,0,0\n';
  input.files['pathways.txt'] = 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\np,B,D,1,0,60,100\n';
  return input;
}

export function entranceInput() {
  const input = plannerInput();
  input.files['stops.txt'] = 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
    'X,West station,37,-122,1,\nY,East station,37.0005,-122,1,\n' +
    'A,West entrance,37,-122,2,X\nB,West platform,37,-122,0,X\n' +
    'D,East entrance,37.0005,-122,2,Y\nE,East platform,37.0005,-122,0,Y\nC,Destination,37.04,-122,0,\n';
  input.files['pathways.txt'] = 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\nwest,A,B,1,1,20,20\neast,D,E,1,1,20,20\n';
  input.files['stop_times.txt'] = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT,09:01:00,09:01:00,E,1,0,0\nT,09:20:00,09:20:00,C,2,0,0\n';
  return input;
}
/** Hand-authored oracle: no planner logic or derived planner output is used. */
export function golden(fixture: Awaited<ReturnType<typeof plannerFixture>>): Itinerary {
  const leg: TransitLeg = {
    kind: 'transit', tripRef: ref('trip', 'T'),
    tripInstanceRef: formatTripInstanceRef({ coverage: 'sfbay', feed: 'sf511', id: 'T', serviceDate: '20261019', startTime: '09:00:00' }),
    serviceDate: '20261019', instanceStartSeconds: 32400, routeRef: ref('route', 'R'), directionId: 0, headsign: 'Destination',
    from: ref('stop', 'A'), to: ref('stop', 'C'), boardSequence: 1, alightSequence: 3,
    scheduledDepartureTime: at('09:00:00'), scheduledArrivalTime: at('09:20:00'),
    departureTime: at('09:00:00'), arrivalTime: at('09:20:00'), status: 'scheduled_only',
    scheduleVersion: fixture.compiled.shard.source.sha256, continuation: false,
  };
  return { coverageId: 'sfbay', artifactVersion: fixture.version.artifactVersion,
    origin: ref('stop', 'A'), destination: ref('stop', 'C'), departAt: at('08:59:00'), windowSeconds: 7200,
    maxWalkMetres: 0, maxTransfers: 3, departureTime: at('09:00:00'), arrivalTime: at('09:20:00'),
    walkingMetres: 0, transfers: 0, status: 'scheduled_only', legs: [leg] };
}
