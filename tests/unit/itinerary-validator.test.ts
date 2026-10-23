import { describe, expect, it } from 'vitest';
import { validateItinerary } from '../../src/transit/planner/validator';
import { at, entranceInput, golden, goldenTransfer, pathwayInput, plannerFixture, plannerInput, ref, transferInput } from '../helpers/planner-fixture';
import type { Itinerary, TransitLeg } from '../../src/transit/planner/types';

describe('independent itinerary validation against canonical stop-times', () => {
  it('keeps initial validation strict and rejects recheck tampering while allowing an older matching observation', async () => {
    const f = await plannerFixture(), candidate = golden(f), leg = candidate.legs[0] as TransitLeg;
    const now = Date.parse(f.query.now) / 1000;
    leg.status = candidate.status = 'realtime'; leg.realtimeTimestampSeconds = now - 30;
    const source = { ...f.source, realtime: { version: f.version, producerTimestampSeconds: now, receivedAtSeconds: now,
      payload: [{ entityId: 'first', tripInstanceRef: leg.tripInstanceRef, stopId: 'A', stopSequence: 1, status: 'realtime' as const, departureTimeSeconds: Date.parse(at('09:00:00')) / 1000 }] } };
    expect((await validateItinerary(candidate, source)).reasons).toContain('REALTIME_PROVENANCE');
    expect((await validateItinerary(candidate, { ...source, recheck: true })).valid).toBe(true);
    leg.realtimeTimestampSeconds = now + 1;
    expect((await validateItinerary(candidate, { ...source, recheck: true })).reasons).toContain('REALTIME_PROVENANCE');
    leg.realtimeTimestampSeconds = now - 30; leg.scheduledDepartureTime = at('09:01:00');
    expect((await validateItinerary(candidate, { ...source, recheck: true })).reasons).toContain('SCHEDULED_TIME');
  });
  it('rechecks a journey on current times: a delay that keeps the change is fine, one that misses it is not', async () => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    const f = await plannerFixture(input), candidate = goldenTransfer(f), now = Date.parse(f.query.now) / 1000;
    const first = candidate.legs[0] as TransitLeg;
    // The first ride reaches the change at 09:10; the second leaves at 09:12.
    const recheck = (arrives: string) => validateItinerary(candidate, { ...f.source, recheck: true, realtime: { version: f.version, producerTimestampSeconds: now, receivedAtSeconds: now,
      payload: [{ entityId: 'first', tripInstanceRef: first.tripInstanceRef, stopId: 'B', stopSequence: 2, status: 'realtime' as const, arrivalTimeSeconds: Date.parse(at(arrives)) / 1000 }] } });
    expect(await recheck('09:11:00')).toMatchObject({ valid: true, reasons: [] });
    expect(await recheck('09:13:00')).toMatchObject({ valid: false, reasons: ['MISSED_CONNECTION'], transferFailures: [{ fromLegIndex: 0, toLegIndex: 1, reasons: ['MISSED_CONNECTION'] }] });
  });
  it('requires the least authoritative transit leg for a mixed journey', async () => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    const f = await plannerFixture(input), candidate = goldenTransfer(f), now = Date.parse(f.query.now) / 1000;
    const first = candidate.legs[0] as TransitLeg;
    first.status = 'realtime'; first.realtimeTimestampSeconds = now;
    const source = { ...f.source, realtime: { version: f.version, producerTimestampSeconds: now, receivedAtSeconds: now,
      payload: [{ entityId: 'first', tripInstanceRef: first.tripInstanceRef, stopId: 'A', stopSequence: 1, status: 'realtime' as const, departureTimeSeconds: Date.parse(at('09:00:00')) / 1000 }] } };
    expect(await validateItinerary(candidate, source)).toMatchObject({ valid: true });
    candidate.status = 'realtime';
    expect(await validateItinerary(candidate, source)).toMatchObject({ valid: false, reasons: ['STATUS'] });
  });
  it.each(['canceled', 'skipped'] as const)('localizes a %s second ride without invalidating the first', async status => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    const f = await plannerFixture(input), candidate = goldenTransfer(f), now = Date.parse(f.query.now) / 1000;
    expect((await validateItinerary(candidate, f.source)).valid).toBe(true);
    const result = await validateItinerary(candidate, { ...f.source, realtime: { version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, payload: [{ entityId: 'second', stopId: 'B', stopSequence: 1,
        tripInstanceRef: 'tr:sfbay:sf511:trip:VQ:20261019:MDk6MTI6MDA', status }] } });
    expect(result).toMatchObject({ valid: false, legFailures: [{ index: 1, reasons: [status === 'canceled' ? 'TRIP_CANCELED' : 'STOP_SKIPPED'] }], transferFailures: [] });
  });

  it('localizes an invalid transfer boundary without invalidating either ride', async () => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    input.files['transfers.txt'] = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,B,2,180\n';
    const f = await plannerFixture(input);
    expect(await validateItinerary(goldenTransfer(f), f.source)).toMatchObject({ valid: false, reasons: ['TRANSFER_MINIMUM'],
      legFailures: [], transferFailures: [{ fromLegIndex: 0, toLegIndex: 1, reasons: ['TRANSFER_MINIMUM'] }] });
  });
  it('deduplicates identical dated pathway metadata but rejects conflicting definitions', async () => {
    const f = await plannerFixture(pathwayInput()), candidate = golden(f), first = candidate.legs[0] as TransitLeg;
    Object.assign(first, { headsign: 'Interchange', to: ref('stop', 'B'), alightSequence: 2, arrivalTime: at('09:10:00'), scheduledArrivalTime: at('09:10:00') });
    candidate.legs.push({ kind: 'walk', from: ref('stop', 'B'), to: ref('stop', 'D'), departureTime: at('09:10:00'), arrivalTime: at('09:11:40'),
      distanceMetres: 60, verification: 'pathway', pathwayId: 'p', estimated: false },
    { ...first, tripRef: ref('trip', 'U'), tripInstanceRef: 'tr:sfbay:sf511:trip:VQ:20261019:MDk6MTI6MDA', routeRef: ref('route', 'S'),
      directionId: 1, headsign: 'Destination', from: ref('stop', 'D'), to: ref('stop', 'C'), boardSequence: 1, alightSequence: 2,
      instanceStartSeconds: 33120, scheduledDepartureTime: at('09:12:00'), departureTime: at('09:12:00'), scheduledArrivalTime: at('09:25:00'), arrivalTime: at('09:25:00') });
    candidate.arrivalTime = at('09:25:00'); candidate.transfers = 1; candidate.walkingMetres = 60; candidate.maxWalkMetres = 100;
    expect((await validateItinerary(candidate, f.source)).valid).toBe(true);
    const dated = structuredClone(f.source.shards[0]!); dated.window = { startDate: '20261001', endDate: '20261018' };
    expect((await validateItinerary(candidate, { ...f.source, shards: [...f.source.shards, dated] })).valid).toBe(true);
    dated.pathways[0]!.traversalSeconds = 110;
    expect((await validateItinerary(candidate, { ...f.source, shards: [...f.source.shards, dated] })).valid).toBe(false);
  });

  it('independently proves block adjacency between dated instances of the same frequency template', async () => {
    const input = plannerInput();
    input.files['trips.txt'] = input.files['trips.txt'].replace('Destination,0,', 'Destination,0,block');
    input.files['stop_times.txt'] = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT,09:00:00,09:00:00,A,1,0,0\nT,09:05:00,09:05:00,A,2,0,0\n';
    input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,09:30:00,600,1\n';
    const f = await plannerFixture(input), candidate = golden(f), first = candidate.legs[0] as TransitLeg;
    Object.assign(first, { to: ref('stop', 'A'), alightSequence: 2, scheduledArrivalTime: at('09:05:00'), arrivalTime: at('09:05:00') });
    candidate.destination = ref('stop', 'A'); candidate.arrivalTime = at('09:15:00');
    candidate.legs.push({ ...first, tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MTA6MDA', instanceStartSeconds: 33000,
      scheduledDepartureTime: at('09:10:00'), departureTime: at('09:10:00'), scheduledArrivalTime: at('09:15:00'), arrivalTime: at('09:15:00'), continuation: true });
    expect((await validateItinerary(candidate, f.source)).valid).toBe(true);
    Object.assign(candidate.legs[1]!, { tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MjA6MDA', instanceStartSeconds: 33600,
      scheduledDepartureTime: at('09:20:00'), departureTime: at('09:20:00'), scheduledArrivalTime: at('09:25:00'), arrivalTime: at('09:25:00') });
    candidate.arrivalTime = at('09:25:00');
    expect((await validateItinerary(candidate, f.source)).valid).toBe(false);
  });

  it('accepts a bounded exterior entrance connection and rejects an invented internal shortcut', async () => {
    const f = await plannerFixture(entranceInput()), candidate = golden(f), ride = candidate.legs[0] as TransitLeg;
    Object.assign(ride, { from: ref('stop', 'E'), alightSequence: 2, instanceStartSeconds: 32460,
      tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDE6MDA', departureTime: at('09:01:00'), scheduledDepartureTime: at('09:01:00') });
    candidate.maxWalkMetres = 100; candidate.walkingMetres = 76; candidate.departureTime = at('08:59:00');
    candidate.legs.unshift({ kind: 'walk', from: ref('stop', 'A'), to: ref('stop', 'D'), departureTime: at('08:59:00'), arrivalTime: at('08:59:45'),
      distanceMetres: 56, verification: 'unverified', estimated: true },
    { kind: 'walk', from: ref('stop', 'D'), to: ref('stop', 'E'), departureTime: at('08:59:45'), arrivalTime: at('09:00:05'),
      distanceMetres: 20, verification: 'pathway', pathwayId: 'east', estimated: false });
    expect((await validateItinerary(candidate, f.source)).valid).toBe(true);
    candidate.legs.splice(1, 1, { kind: 'walk', from: ref('stop', 'D'), to: ref('stop', 'E'), departureTime: at('08:59:45'), arrivalTime: at('08:59:45'),
      distanceMetres: 0, verification: 'unverified', estimated: true }); candidate.walkingMetres = 56;
    expect((await validateItinerary(candidate, f.source)).valid).toBe(false);
  });
  it('accepts a hand-authored valid journey without calling the router', async () => {
    const f = await plannerFixture();
    expect(await validateItinerary(golden(f), f.source)).toEqual({ valid: true, reasons: [], legFailures: [], transferFailures: [] });
  });

  // Each mutation models one incorrect planner claim; the oracle is hand-authored above.
  const corruptions: [string, (i: Itinerary, leg: TransitLeg) => void][] = [
    ['wrong route', (_, leg) => { leg.routeRef = ref('route', 'S'); }],
    ['wrong direction', (_, leg) => { leg.directionId = 1; }],
    ['wrong headsign', (_, leg) => { leg.headsign = 'Origin'; }],
    ['reversed stop order', (_, leg) => { leg.boardSequence = 3; leg.alightSequence = 1; }],
    ['unknown trip', (_, leg) => { leg.tripRef = ref('trip', 'missing'); }],
    ['wrong boarding stop', (_, leg) => { leg.from = ref('stop', 'B'); }],
    ['wrong alighting stop', (_, leg) => { leg.to = ref('stop', 'B'); }],
    ['wrong service day', (_, leg) => { leg.serviceDate = '20261018'; }],
    ['wrong instance start', (_, leg) => { leg.instanceStartSeconds += 60; }],
    ['wrong instance reference', (_, leg) => { leg.tripInstanceRef = `${leg.tripInstanceRef}x` as typeof leg.tripInstanceRef; }],
    ['wrong schedule version', (_, leg) => { leg.scheduleVersion = 'a'.repeat(64); }],
    ['wrong artifact version', i => { i.artifactVersion = 'a'.repeat(64); }],
    ['altered scheduled departure', (_, leg) => { leg.scheduledDepartureTime = at('09:01:00'); }],
    ['altered scheduled arrival', (_, leg) => { leg.scheduledArrivalTime = at('09:19:00'); }],
    ['invented prediction', (_, leg) => { leg.departureTime = at('09:01:00'); leg.status = 'realtime'; }],
    ['nonmonotonic adjusted time', (_, leg) => { leg.arrivalTime = at('08:59:00'); }],
    ['missing realtime provenance', (_, leg) => { leg.status = 'realtime'; }],
    ['invented continuation', (_, leg) => { leg.continuation = true; }],
    ['departure before request', i => { i.departAt = at('09:01:00'); }],
    ['wrong destination', i => { i.destination = ref('stop', 'B'); }],
    ['wrong origin', i => { i.origin = ref('stop', 'B'); }],
    ['wrong arrival summary', i => { i.arrivalTime = at('09:21:00'); }],
    ['wrong departure summary', i => { i.departureTime = at('09:01:00'); }],
    ['wrong transfer count', i => { i.transfers = 1; }],
    ['wrong walking total', i => { i.walkingMetres = 100; }],
    ['wrong status', i => { i.status = 'realtime'; }],
    ['outside query horizon', i => { i.windowSeconds = 30; }],
    ['missing legs', i => { i.legs = []; }],
  ];
  it.each(corruptions)('rejects %s without mutating or repairing the candidate', async (_name, mutate) => {
    const f = await plannerFixture(); const candidate = golden(f); mutate(candidate, candidate.legs[0] as TransitLeg);
    const before = structuredClone(candidate);
    expect((await validateItinerary(candidate, f.source)).valid).toBe(false);
    expect(candidate).toEqual(before);
    expect((await validateItinerary(golden(f), f.source)).valid).toBe(true);
  });

  it('rejects inactive service, no-pickup, no-dropoff, and non-exact templates using canonical evidence', async () => {
    for (const change of ['inactive', 'pickup', 'dropoff', 'frequency']) {
      const input = plannerInput();
      if (change === 'inactive') input.files['calendar_dates.txt'] = 'service_id,date,exception_type\nD,20261019,2\n';
      if (change === 'pickup') input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('A,1,0,0', 'A,1,1,0');
      if (change === 'dropoff') input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('C,3,0,0', 'C,3,0,1');
      if (change === 'frequency') input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,600,0\n';
      const f = await plannerFixture(input);
      expect((await validateItinerary(golden(f), f.source)).valid, change).toBe(false);
    }
  });

  it('rejects canceled or skipped boarding and honors AbortSignal', async () => {
    const f = await plannerFixture(); const candidate = golden(f);
    for (const status of ['canceled', 'skipped'] as const) {
      const realtime = { version: f.version, producerTimestampSeconds: Date.parse(f.query.now) / 1000, receivedAtSeconds: Date.parse(f.query.now) / 1000,
        payload: [{ entityId: 'e', tripInstanceRef: (candidate.legs[0] as TransitLeg).tripInstanceRef, stopId: 'A', stopSequence: 1, status }] };
      expect((await validateItinerary(candidate, { ...f.source, realtime })).valid).toBe(false);
    }
    const controller = new AbortController(); controller.abort();
    await expect(validateItinerary(candidate, f.source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checks transfer timing and continuation independently on a hand-authored two-trip itinerary', async () => {
    const input = transferInput();
    input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    input.files['transfers.txt'] = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,B,2,120\n';
    const f = await plannerFixture(input), itinerary = golden(f);
    const first = itinerary.legs[0] as TransitLeg;
    Object.assign(first, { headsign: 'Interchange', to: ref('stop', 'B'), alightSequence: 2, scheduledArrivalTime: at('09:10:00'), arrivalTime: at('09:10:00') });
    itinerary.legs.push({ ...first, tripRef: ref('trip', 'U'), tripInstanceRef: 'tr:sfbay:sf511:trip:VQ:20261019:MDk6MTI6MDA', routeRef: ref('route', 'S'),
      directionId: 1, headsign: 'Destination', from: ref('stop', 'B'), to: ref('stop', 'C'), boardSequence: 1, alightSequence: 2,
      instanceStartSeconds: 33120, scheduledDepartureTime: at('09:12:00'), departureTime: at('09:12:00'), scheduledArrivalTime: at('09:25:00'), arrivalTime: at('09:25:00') });
    itinerary.arrivalTime = at('09:25:00'); itinerary.transfers = 1;
    expect((await validateItinerary(itinerary, f.source)).valid).toBe(true);
    for (const change of ['minimum', 'forbidden', 'continuation', 'disconnect', 'transfer_count']) {
      const source = structuredClone(f.source), candidate = structuredClone(itinerary);
      if (change === 'minimum') source.shards[0]!.transfers[0]!.minTransferSeconds = 121;
      if (change === 'forbidden') source.shards[0]!.transfers[0]!.transferType = 3;
      if (change === 'continuation') (candidate.legs[1] as TransitLeg).continuation = true;
      if (change === 'disconnect') (candidate.legs[1] as TransitLeg).from = ref('stop', 'D');
      if (change === 'transfer_count') candidate.transfers = 0;
      expect((await validateItinerary(candidate, source)).valid, change).toBe(false);
    }
  });

  it('rejects stale, future, mismatched and unproven realtime claims but keeps the fresh oracle valid', async () => {
    const f = await plannerFixture(), candidate = golden(f), leg = candidate.legs[0] as TransitLeg;
    const timestamp = Date.parse(f.query.now) / 1000;
    Object.assign(leg, { departureTime: at('09:01:00'), status: 'realtime', realtimeTimestampSeconds: timestamp });
    candidate.departureTime = leg.departureTime; candidate.status = 'realtime';
    const realtime = { version: f.version, producerTimestampSeconds: timestamp, receivedAtSeconds: timestamp,
      payload: [{ entityId: 'e', tripInstanceRef: leg.tripInstanceRef, stopId: 'A', stopSequence: 1, departureTimeSeconds: Date.parse(leg.departureTime) / 1000, status: 'realtime' as const }] };
    expect((await validateItinerary(candidate, { ...f.source, realtime })).valid).toBe(true);
    for (const change of ['stale', 'future', 'artifact', 'source', 'timestamp', 'stop', 'monotonic']) {
      const snapshot = structuredClone(realtime), mutated = structuredClone(candidate);
      if (change === 'stale') snapshot.producerTimestampSeconds -= 1000;
      if (change === 'future') snapshot.producerTimestampSeconds += 1;
      if (change === 'artifact') snapshot.version.artifactVersion = 'bad';
      if (change === 'source') snapshot.version.sourceVersions.sf511 = 'bad';
      if (change === 'timestamp') (mutated.legs[0] as TransitLeg).realtimeTimestampSeconds! -= 1;
      if (change === 'stop') snapshot.payload[0]!.stopId = 'B';
      if (change === 'monotonic') snapshot.payload.push({ ...snapshot.payload[0]!, stopId: 'B', stopSequence: 2, departureTimeSeconds: Date.parse(at('09:30:00')) / 1000 });
      expect((await validateItinerary(mutated, { ...f.source, realtime: snapshot })).valid, change).toBe(false);
    }
  });

  it('rejects every corrupted walking claim while preserving a hand-measured valid access walk', async () => {
    const f = await plannerFixture(), candidate = golden(f);
    candidate.origin = { latitude: 37.001, longitude: -122 }; candidate.departAt = at('08:55:00');
    candidate.maxWalkMetres = 112; candidate.walkingMetres = 112; candidate.departureTime = at('08:55:00');
    candidate.legs.unshift({ kind: 'walk', from: candidate.origin, to: ref('stop', 'A'), distanceMetres: 112,
      departureTime: at('08:55:00'), arrivalTime: at('08:56:30'), verification: 'unverified', estimated: true });
    expect((await validateItinerary(candidate, f.source)).valid).toBe(true);
    for (const change of ['distance', 'time', 'verified', 'budget', 'total', 'pathway', 'endpoint']) {
      const mutated = structuredClone(candidate), walk = mutated.legs[0]; if (walk?.kind !== 'walk') throw new Error('fixture');
      if (change === 'distance') walk.distanceMetres = 111;
      if (change === 'time') walk.arrivalTime = at('08:56:29');
      if (change === 'verified') walk.estimated = false;
      if (change === 'budget') mutated.maxWalkMetres = 111;
      if (change === 'total') mutated.walkingMetres = 111;
      if (change === 'pathway') { walk.verification = 'pathway'; walk.pathwayId = 'invented'; }
      if (change === 'endpoint') walk.to = ref('stop', 'B');
      expect((await validateItinerary(mutated, f.source)).valid, change).toBe(false);
    }
  });

  it('checks canonical intermediate scheduled times independently of plausible leg endpoints', async () => {
    const f = await plannerFixture(), candidate = golden(f), corrupted = structuredClone(f.source);
    const middle = corrupted.shards[0]!.trips[0]!.stopTimes[1]!;
    middle.arrivalSeconds = 34200; middle.departureSeconds = 34200;
    expect((await validateItinerary(candidate, corrupted)).valid).toBe(false);
    expect((await validateItinerary(candidate, f.source)).valid).toBe(true);
  });
});
