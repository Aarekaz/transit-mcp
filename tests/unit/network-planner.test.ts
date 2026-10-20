import { describe, expect, it } from 'vitest';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { decodeScheduleShard } from '../../src/transit/gtfs/static/shards';
import { buildCompactBand, parseCompactBand, NO_PICKUP } from '../../src/transit/planner/compact';
import { networkStops, searchNetwork, type NetworkQuery } from '../../src/transit/planner/network';
import { serviceDayOrigin } from '../../src/transit/planner/service-day';
import { pathwayInput, plannerInput, ref, transferInput } from '../helpers/planner-fixture';
import type { CompileScheduleInput } from '../../src/transit/gtfs/static/schema';

const day = { startDate: '20261019', endDate: '20261019' };
async function band(input: CompileScheduleInput) {
  const compiled = await compileSchedule({ ...input, window: day });
  const bytes = buildCompactBand(compiled.shard, compiled.discovery, compiled.manifest.shards[0]!.sha256, compiled.manifest.discoveries[0]!.sha256);
  return { compiled, band: parseCompactBand(bytes) };
}
const begin = serviceDayOrigin('20261019', 'America/Los_Angeles') / 1000 + 8 * 3600 + 59 * 60;
async function query(input: CompileScheduleInput, extra: Partial<NetworkQuery> = {}): Promise<NetworkQuery> {
  const { compiled, band: built } = await band(input);
  return { stops: networkStops([compiled.discovery]), bands: [{ band: built, origins: [serviceDayOrigin('20261019', 'America/Los_Angeles') / 1000] }],
    origin: ref('stop', 'A'), destination: ref('stop', 'C'), begin, end: begin + 7200, maxWalkMetres: 0, maxTransfers: 3, ...extra };
}

describe('compact bands', () => {
  // Breaks if a trip that overtakes another shares its pattern: boarding by binary search
  // would then miss the faster trip.
  it('keeps every pattern FIFO by splitting overtaking trips', async () => {
    const input = plannerInput();
    input.files['trips.txt'] += 'R,D,X,Destination,0,\n';
    // X leaves after T but arrives first.
    input.files['stop_times.txt'] += 'X,09:02:00,09:02:00,A,1,0,0\nX,09:06:00,09:06:00,B,2,0,0\nX,09:09:00,09:09:00,C,3,0,0\n';
    const { band: built } = await band(input);
    expect(built.header.patterns).toBe(2);
    for (let pattern = 0; pattern < built.header.patterns; pattern++) expect(built.tripStart[pattern + 1]! - built.tripStart[pattern]!).toBe(1);
  });

  // Breaks if untimed calls are dropped (stop indexes and times misalign) or frequencies ignored.
  it('interpolates untimed calls and expands frequencies', async () => {
    const input = plannerInput();
    input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('T,09:10:00,09:10:00,B,2,0,0', 'T,,,B,2,1,0');
    input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,1200,1\n';
    const { band: built } = await band(input);
    expect(built.header.trips).toBe(3);
    expect([...built.times.subarray(0, 6)]).toEqual([32400, 32400, 33000, 33000, 33600, 33600]);
    expect(built.stopFlags[1]! & NO_PICKUP).toBe(NO_PICKUP);
    expect(built.times[6]).toBe(32400 + 1200);
  });

  it('rejects bytes that are not a compact band', () => {
    expect(() => parseCompactBand(new Uint8Array(16))).toThrow('Invalid compact band');
  });
});

describe('network search', () => {
  // Breaks if rounds do not carry arrivals forward or backtracking loses a ride.
  it('proposes the lines of a journey with a change', async () => {
    const journeys = searchNetwork(await query(transferInput()));
    expect(journeys.map(journey => journey.rides.map(ride => ride.routeRef))).toEqual([[ref('route', 'R'), ref('route', 'S')]]);
    expect(journeys[0]!.arrival - begin).toBe(26 * 60);
  });

  // Breaks if a banned line is still ridden (the alternative search would repeat itself).
  it('avoids banned lines', async () => {
    expect(searchNetwork(await query(transferInput()), new Set([ref('route', 'S')]))).toEqual([]);
  });

  // Breaks if step-free searches board where the platform is not usable.
  it('boards and alights only at usable stops when step-free', async () => {
    const usable = new Set([ref('stop', 'A'), ref('stop', 'C')]);
    expect(searchNetwork(await query(plannerInput(), { usableStops: usable }))).toHaveLength(1);
    expect(searchNetwork(await query(transferInput(), { usableStops: usable }))).toEqual([]);
  });

  // Breaks if a walk to a nearby stop is not offered as a change.
  it('changes lines by walking to a nearby stop within the limit', async () => {
    const input = transferInput();
    input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('U,09:12:00,09:12:00,B', 'U,09:12:00,09:12:00,D');
    expect(searchNetwork(await query(input))).toEqual([]);
    expect(searchNetwork(await query(input, { maxWalkMetres: 100 }))).toHaveLength(1);
  });
});

describe('route-filtered shard decoding', () => {
  // Breaks if a filtered decode drops a station's other stops (its pathways would no longer
  // connect), keeps another route's trips, or misaligns rows after dropped trips and stops.
  it('keeps only the named routes, their stations and what connects them', async () => {
    const input = pathwayInput();
    input.files['stops.txt'] += 'Z,Elsewhere,38,-121\n';
    input.files['trips.txt'] += 'R,D,Q,Elsewhere,0,\n';
    input.files['stop_times.txt'] += 'Q,10:00:00,10:00:00,Z,1,0,0\nQ,10:10:00,10:10:00,A,2,0,0\n';
    const { shardBytes } = await compileSchedule({ ...input, window: day });
    const whole = decodeScheduleShard(shardBytes), only = decodeScheduleShard(shardBytes, new Set([ref('route', 'S')]));
    expect(only.trips.map(trip => trip.ref).sort()).toEqual(whole.trips.filter(trip => trip.routeRef === ref('route', 'S')).map(trip => trip.ref).sort());
    for (const trip of only.trips) expect(trip.stopTimes).toEqual(whole.trips.find(other => other.ref === trip.ref)!.stopTimes);
    expect(only.stops.map(stop => stop.ref)).not.toContain(ref('stop', 'Z'));
    expect(only.pathways).toEqual(whole.pathways.filter(path => only.stops.some(stop => stop.ref === path.fromStopRef) && only.stops.some(stop => stop.ref === path.toStopRef)));
  });
});
