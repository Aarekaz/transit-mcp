import { describe, expect, it } from 'vitest';
import { planJourney } from '../../src/transit/planner/plan';
import { routeDepartAt } from '../../src/transit/planner/raptor';
import { loadScheduleWindow } from '../../src/transit/planner/schedule-index';
import { at, colocatedInput, entranceInput, pathwayInput, plannerFixture, plannerInput, ref, transferInput } from '../helpers/planner-fixture';
import type { NormalizedStopUpdate } from '../../src/transit/gtfs/realtime/decode';
import type { NormalizedRealtimeSnapshot } from '../../src/transit/gtfs/realtime/snapshot-store';

describe('depart-at transit routing', () => {
  it('bounds colocated walking states while retaining distinct transit alternatives', async () => {
    const f = await plannerFixture(colocatedInput());
    const began = performance.now();
    const result = await planJourney({ ...f.query, maxWalkMetres: 800 });
    expect(performance.now() - began).toBeLessThan(250);
    expect(result.candidates.map(candidate => candidate.arrivalTime)).toEqual([at('09:20:00'), at('09:25:00')]);
    expect(result.diagnostics.estimatedWorkingSetBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it('keeps a valid slower transfer when the faster direct candidate fails validation', async () => {
    const input = transferInput();
    input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',') + 'R,D,V,Destination,0,\n';
    input.files['stop_times.txt'] += 'V,09:00:00,09:00:00,A,1,0,0\nV,09:10:00,09:10:00,D,2,0,0\nV,09:20:00,09:20:00,C,3,0,0\n';
    const f = await plannerFixture(input);
    const realtime = { version: f.version, producerTimestampSeconds: Date.parse(f.query.now) / 1000, receivedAtSeconds: Date.parse(f.query.now) / 1000,
      payload: [{ entityId: 'e', tripInstanceRef: 'tr:sfbay:sf511:trip:Vg:20261019:MDk6MDA6MDA', stopId: 'D', stopSequence: 2,
        departureTimeSeconds: Date.parse(at('09:30:00')) / 1000, status: 'realtime' as const }] };
    expect(await planJourney({ ...f.query, realtime })).toMatchObject({ reasons: ['VALIDATOR_REJECTED'], candidates: [{ arrivalTime: at('09:25:00'), transfers: 1 }] });
  });

  it.each([false, true])('boards fresh delayed service after its scheduled end (frequency=%s)', async frequency => {
    const input = plannerInput();
    if (frequency) input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,09:01:00,600,1\n';
    const f = await plannerFixture(input), now = at('09:21:00');
    const realtime = { version: f.version, producerTimestampSeconds: Date.parse(now) / 1000, receivedAtSeconds: Date.parse(now) / 1000,
      payload: ['A', 'B', 'C'].map((stopId, index) => ({ entityId: 'e', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', stopId, stopSequence: index + 1,
        arrivalTimeSeconds: Date.parse(at(['09:25:00', '09:35:00', '09:45:00'][index]!)) / 1000,
        departureTimeSeconds: Date.parse(at(['09:25:00', '09:35:00', '09:45:00'][index]!)) / 1000, status: 'realtime' as const })) };
    expect((await planJourney({ ...f.query, now, departAt: now, realtime })).candidates[0]).toMatchObject({ departureTime: at('09:25:00'), arrivalTime: at('09:45:00'), status: 'realtime' });
  });

  it('returns the same pathway itinerary across one or two dated shards', async () => {
    const input = pathwayInput(), single = await plannerFixture(input), split = await plannerFixture(input, [
      { startDate: '20260101', endDate: '20261018' }, { startDate: '20261019', endDate: '20261231' },
    ]);
    const one = await planJourney({ ...single.query, maxWalkMetres: 100 });
    const two = await planJourney({ ...split.query, maxWalkMetres: 100 });
    expect(one.candidates).toHaveLength(1);
    expect(two.candidates.map(candidate => candidate.legs)).toEqual(one.candidates.map(candidate => candidate.legs));
    expect(split.reads).toHaveLength(2);
  });

  it('allows exterior entrance walks between stations while preserving each internal pathway', async () => {
    const f = await plannerFixture(entranceInput());
    const result = await planJourney({ ...f.query, maxWalkMetres: 100 });
    expect(result.candidates[0]?.legs).toMatchObject([
      { kind: 'walk', from: ref('stop', 'A'), to: ref('stop', 'D'), verification: 'unverified', estimated: true, distanceMetres: 56 },
      { kind: 'walk', from: ref('stop', 'D'), to: ref('stop', 'E'), verification: 'pathway', pathwayId: 'east' }, { kind: 'transit' },
    ]);
  });
  it('finds a deterministic direct trip from canonical stop order and reads only the required window', async () => {
    const f = await plannerFixture();
    const result = await planJourney(f.query);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ arrivalTime: at('09:20:00'), transfers: 0,
      legs: [{ tripRef: ref('trip', 'T'), from: ref('stop', 'A'), to: ref('stop', 'C'), boardSequence: 1, alightSequence: 3 }] });
    expect(f.reads).toEqual([f.compiled.manifest.shards[0]!.key]);
    expect((await planJourney(f.query)).candidates).toEqual(result.candidates);
    expect((await planJourney({ ...f.query, origin: ref('stop', 'C'), destination: ref('stop', 'A') })).candidates).toEqual([]);
  });

  it('does not board a departed trip or an inactive calendar day', async () => {
    const input = plannerInput(); input.files['calendar_dates.txt'] = 'service_id,date,exception_type\nD,20261019,2\n';
    expect((await planJourney((await plannerFixture(input)).query)).candidates).toEqual([]);
    const f = await plannerFixture();
    expect((await planJourney({ ...f.query, departAt: at('09:00:01') })).candidates).toEqual([]);
  });

  it('finds a transfer and honors minimum transfer seconds even when the vehicle block matches', async () => {
    const input = transferInput();
    input.files['transfers.txt'] = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,B,2,180\n';
    expect((await planJourney((await plannerFixture(input)).query)).candidates).toEqual([]);
    input.files['transfers.txt'] = input.files['transfers.txt'].replace('180', '120');
    const result = await planJourney((await plannerFixture(input)).query);
    expect(result.candidates[0]).toMatchObject({ arrivalTime: at('09:25:00'), legs: [{ tripRef: ref('trip', 'T') }, { tripRef: ref('trip', 'U') }] });
  });

  it('keeps same-vehicle continuation in the same boarding round and obeys type 5', async () => {
    const input = transferInput();
    let f = await plannerFixture(input);
    expect((await planJourney({ ...f.query, maxTransfers: 0 })).candidates[0]).toMatchObject({ transfers: 0, legs: [{ continuation: false }, { continuation: true }] });
    input.files['transfers.txt'] = 'from_trip_id,to_trip_id,transfer_type\nT,U,5\n';
    f = await plannerFixture(input);
    expect((await planJourney({ ...f.query, maxTransfers: 0 })).candidates).toEqual([]);
    expect((await planJourney(f.query)).candidates[0]?.transfers).toBe(1);
  });

  it('supports explicit in-seat links between different stops without fabricating a walk', async () => {
    const input = transferInput();
    input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('09:12:00,B', '09:12:00,D');
    input.files['transfers.txt'] = 'from_trip_id,to_trip_id,transfer_type\nT,U,4\n';
    const f = await plannerFixture(input);
    expect((await planJourney({ ...f.query, maxTransfers: 0 })).candidates[0]).toMatchObject({ transfers: 0, walkingMetres: 0,
      legs: [{ to: ref('stop', 'B') }, { from: ref('stop', 'D'), continuation: true }] });
  });

  it('does not invent a block continuation that skips an intervening vehicle trip', async () => {
    const input = transferInput();
    input.files['trips.txt'] += 'S,D,V,Elsewhere,0,block\n';
    input.files['stop_times.txt'] += 'V,09:10:30,09:10:30,B,1,0,0\nV,09:11:30,09:11:30,D,2,0,0\n';
    const f = await plannerFixture(input);
    expect((await planJourney({ ...f.query, maxTransfers: 0 })).candidates).toEqual([]);
  });

  it('does not hide valid realtime arrival-only predictions behind a scheduled terminal departure', async () => {
    const f = await plannerFixture();
    const realtime = { version: f.version, producerTimestampSeconds: Date.parse(f.query.now) / 1000, receivedAtSeconds: Date.parse(f.query.now) / 1000,
      payload: [{ entityId: 'e', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', stopId: 'C', stopSequence: 3,
        arrivalTimeSeconds: Date.parse(at('09:22:00')) / 1000, status: 'realtime' as const }] };
    expect((await planJourney({ ...f.query, realtime })).candidates[0]).toMatchObject({ arrivalTime: at('09:22:00'), status: 'realtime' });
  });

  it('applies a trip-specific transfer over a generic prohibition', async () => {
    const input = transferInput();
    input.files['transfers.txt'] = 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\nB,B,,,3,\nB,B,T,U,2,120\n';
    expect((await planJourney((await plannerFixture(input)).query)).candidates).toHaveLength(1);
    input.files['transfers.txt'] = input.files['transfers.txt'].replace('2,120', '3,');
    expect((await planJourney((await plannerFixture(input)).query)).candidates).toEqual([]);
  });

  it('uses directed pathways with their traversal duration', async () => {
    const input = transferInput();
    input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('09:12:00,B', '09:12:00,D');
    input.files['pathways.txt'] = 'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time\np,B,D,1,0,60,100\n';
    const f = await plannerFixture(input);
    const result = await planJourney({ ...f.query, maxWalkMetres: 100 });
    expect(result.candidates[0]?.legs).toMatchObject([{ kind: 'transit' }, { kind: 'walk', pathwayId: 'p', estimated: false, distanceMetres: 60 }, { kind: 'transit' }]);
    input.files['pathways.txt'] = input.files['pathways.txt'].replace('60,100', '60,130');
    expect((await planJourney({ ...(await plannerFixture(input)).query, maxWalkMetres: 100 })).candidates).toEqual([]);
  });

  it('labels coordinate access as estimated and never allows more than 800 metres of walking', async () => {
    const f = await plannerFixture();
    const near = await planJourney({ ...f.query, origin: { latitude: 37.001, longitude: -122 }, departAt: at('08:55:00'), maxWalkMetres: 1000 });
    expect(near.candidates[0]?.legs[0]).toMatchObject({ kind: 'walk', estimated: true, verification: 'unverified' });
    expect(near.candidates[0]?.maxWalkMetres).toBe(800);
    expect((await planJourney({ ...f.query, origin: { latitude: 37.01, longitude: -122 }, maxWalkMetres: 1000 })).candidates).toEqual([]);
  });

  it('ends street walks only where riders can board, never at nodes or station records', async () => {
    const input = plannerInput();
    input.files['stops.txt'] = 'stop_id,stop_name,stop_lat,stop_lon,location_type\nA,Origin,37,-122,0\nB,Interchange,37.02,-122,0\nC,Destination,37.04,-122,0\n' +
      'D,Nearby platform,37.0205,-122,0\nN1,Node,37.0002,-122,3\nS1,Station record,37.0003,-122,1\nE1,Entrance,37.0004,-122,2\n';
    const f = await plannerFixture(input);
    const result = await planJourney({ ...f.query, origin: { latitude: 37.0001, longitude: -122 }, departAt: at('08:55:00'), maxWalkMetres: 800 });
    const walked = result.candidates.flatMap(candidate => candidate.legs.flatMap(leg => leg.kind === 'walk' ? [leg.to] : []));
    expect(walked.length).toBeGreaterThan(0);
    for (const id of ['N1', 'S1', 'E1']) expect(walked).not.toContain(ref('stop', id));
  });

  it('returns at most three stable exact-frequency alternatives and exposes approximate-only limitations', async () => {
    const input = plannerInput();
    input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,600,1\n';
    const result = await planJourney((await plannerFixture(input)).query);
    expect(result.candidates.map(c => c.arrivalTime)).toEqual([at('09:20:00'), at('09:30:00'), at('09:40:00')]);
    input.files['frequencies.txt'] = input.files['frequencies.txt'].replace('600,1', '600,0');
    expect(await planJourney((await plannerFixture(input)).query)).toMatchObject({ status: 'unavailable', candidates: [], reasons: ['SCHEDULE_APPROXIMATE'] });
    input.files['trips.txt'] += 'R,D,U,Destination,0,\n';
    input.files['stop_times.txt'] += 'U,09:05:00,09:05:00,A,1,0,0\nU,09:30:00,09:30:00,C,2,0,0\n';
    expect(await planJourney((await plannerFixture(input)).query)).toMatchObject({ status: 'scheduled_only', candidates: [{ arrivalTime: at('09:30:00') }], reasons: ['SCHEDULE_APPROXIMATE'] });
  });

  it('does not attribute unrelated headway service to an unreachable destination', async () => {
    const input = plannerInput();
    input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,600,0\n';
    const f = await plannerFixture(input);
    expect((await planJourney({ ...f.query, destination: ref('stop', 'D') })).reasons).not.toContain('SCHEDULE_APPROXIMATE');
  });

  it('discards canceled and skipped rides, uses fresh predictions, and falls back on stale/version-mismatched snapshots', async () => {
    const f = await plannerFixture();
    const instance = 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA';
    const row: NormalizedStopUpdate = { entityId: 'e', tripInstanceRef: instance, tripId: 'T', serviceDate: '20261019', stopId: 'A', stopSequence: 1,
      departureTimeSeconds: Date.parse(at('09:01:00')) / 1000, status: 'realtime' };
    const realtime: NormalizedRealtimeSnapshot<NormalizedStopUpdate> = { version: f.version, producerTimestampSeconds: Date.parse(f.query.now) / 1000,
      receivedAtSeconds: Date.parse(f.query.now) / 1000, payload: [row] };
    expect((await planJourney({ ...f.query, realtime })).candidates[0]?.legs[0]).toMatchObject({ departureTime: at('09:01:00'), status: 'realtime' });
    for (const status of ['canceled', 'skipped'] as const) {
      expect((await planJourney({ ...f.query, realtime: { ...realtime, payload: [{ ...row, status }] } })).candidates).toEqual([]);
    }
    expect(await planJourney({ ...f.query, realtime: { ...realtime, producerTimestampSeconds: realtime.producerTimestampSeconds! - 1000 } }))
      .toMatchObject({ candidates: [{ departureTime: at('09:00:00'), status: 'scheduled_only' }], reasons: ['REALTIME_STALE'] });
    expect(await planJourney({ ...f.query, realtime: { ...realtime, version: { ...f.version, artifactVersion: 'wrong' } } }))
      .toMatchObject({ candidates: [{ status: 'scheduled_only' }], reasons: ['SCHEDULE_REALTIME_MISMATCH'] });
  });

  it('checks cancellation before reads and between routing rounds', async () => {
    const f = await plannerFixture(transferInput());
    const controller = new AbortController(); controller.abort();
    await expect(planJourney(f.query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.reads).toEqual([]);
    const later = new AbortController();
    const pending = planJourney(f.query, later.signal); setTimeout(() => later.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('observes a real signal aborted during the first transit scan before the next round', async () => {
    const f = await plannerFixture();
    const loaded = await loadScheduleWindow({ ...f.query, instant: f.query.departAt });
    const controller = new AbortController();
    let consumed = false;
    const row: NormalizedStopUpdate = { entityId: 'e', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', stopId: 'A', stopSequence: 1,
      get status() { consumed = true; controller.abort(); return 'scheduled_only' as const; } };
    await expect(routeDepartAt(f.query, loaded.shards, f.version.artifactVersion, [row], undefined, 0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(consumed).toBe(true);
  });

  it('discards a candidate with impossible intermediate realtime without repairing it', async () => {
    const f = await plannerFixture();
    const realtime = { version: f.version, producerTimestampSeconds: Date.parse(f.query.now) / 1000, receivedAtSeconds: Date.parse(f.query.now) / 1000,
      payload: [{ entityId: 'e', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', stopId: 'B', stopSequence: 2,
        departureTimeSeconds: Date.parse(at('09:30:00')) / 1000, status: 'realtime' as const }] };
    const before = structuredClone(realtime);
    expect(await planJourney({ ...f.query, realtime })).toMatchObject({ candidates: [], reasons: ['VALIDATOR_REJECTED'] });
    expect(realtime).toEqual(before);
  });

  it('rejects cross-coverage and invalid queries, and refuses a working set above the budget', async () => {
    const f = await plannerFixture();
    await expect(planJourney({ ...f.query, origin: 'tr:nyc:mta:stop:QQ' })).rejects.toThrow(/coverage/i);
    await expect(planJourney({ ...f.query, departAt: '2026-10-19T09:00:00' })).rejects.toThrow(/offset/i);
    f.query.manifest.shards[0]!.byteLength = 65 * 1024 * 1024;
    await expect(planJourney(f.query)).rejects.toThrow(/budget/i);
    expect(f.reads).toEqual([]);
  });

  it('enforces the working-set budget even when inactive service produces no route labels', async () => {
    const input = plannerInput(); input.files['calendar_dates.txt'] = 'service_id,date,exception_type\nD,20261019,2\n';
    const f = await plannerFixture(input);
    const realtime = { version: f.version, producerTimestampSeconds: Date.parse(f.query.now) / 1000, receivedAtSeconds: Date.parse(f.query.now) / 1000,
      payload: Array<NormalizedStopUpdate>(600000).fill({ entityId: 'unmatched', stopId: 'A' }) };
    await expect(planJourney({ ...f.query, realtime })).rejects.toThrow(/working-set budget/i);
  });

  it('charges retained variable-length leg text in the working-set estimate', async () => {
    const plan = async (headsign: string) => {
      const input = plannerInput();
      input.files['trips.txt'] = input.files['trips.txt'].replace('Destination', headsign);
      input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,10:00:00,600,1\n';
      const f = await plannerFixture(input);
      return planJourney(f.query);
    };
    const short = await plan('D'), long = await plan('D'.repeat(250000));
    expect(long.candidates.length).toBe(short.candidates.length);
    // Each retained leg carries the text; a leg shared by labels is one object, charged once.
    expect(long.diagnostics.estimatedWorkingSetBytes - short.diagnostics.estimatedWorkingSetBytes).toBeGreaterThanOrEqual(250000 * 2);
  });

  it('charges realtime rows as index references, so a rush-hour feed still plans', async () => {
    const f = await plannerFixture(plannerInput());
    // NYC publishes about 17,000 stop-time updates at rush hour.
    const realtime = { version: f.version, producerTimestampSeconds: Date.parse(f.query.now) / 1000, receivedAtSeconds: Date.parse(f.query.now) / 1000,
      payload: Array<NormalizedStopUpdate>(20000).fill({ entityId: 'e'.repeat(512), stopId: 's'.repeat(512), tripId: 't'.repeat(512) }) };
    const result = await planJourney({ ...f.query, realtime });
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});
