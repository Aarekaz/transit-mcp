import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatInstant } from '../../src/transit/planner/service-day';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { NYC_TRIP_FEEDS } from '../../src/regions/nyc';
import { formatEntityRef, formatTripInstanceRef, parseTransitRef } from '../../src/transit/core/refs';
import { RegionFeedHub } from '../../src/transit/gtfs/realtime/region-feed-hub';
import { residentShards } from '../../src/mcp/tools/global/shared';
import { RealtimeSnapshotStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import { memoryStorage } from '../helpers/realtime-fixture';
import { NOW, NYC_FILES, SERVICE_DATE, bandedArtifact, composeFeed, callTool, civil, feedBytes, liveEnv, nowSeconds, nyctEquipmentDocuments, nyctOutage, nyctTrip, nyctVehicle, upstream, wireHub, wmataIncident, wmataIncidentDocument } from '../helpers/dc-nyc-realtime';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const quiet = () => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}); };
type Row = { tripInstanceRef: string; scheduleMatch: string; status: string; scheduledTime: string | null; predictedTime: string | null; stopSequence: number | null; headsign: string };
const tripId = (row: Row) => parseTransitRef(row.tripInstanceRef)!.id;
const instant = (value: string | null) => value === null ? null : new Date(value).toISOString();

/** One complete NYCT poll: a reroute, a train skipping two scheduled stops, and a
 * train absent from the schedule. Every other line's document is present and empty. */
function nycDocuments(stamp = nowSeconds(), overrides: Partial<Record<string, Uint8Array>> = {}) {
  const lines = feedBytes(stamp, [
    // 1 train skips 23 St and 18 St (absent from its remaining calls).
    nyctTrip('054800_1..S03R', '1', [['127S', civil('09:10:00')], ['128S', civil('09:12:00')], ['129S', civil('09:14:00')], ['132S', civil('09:20:00')]], '09:09:41'),
    // 2 express rerouted via the local stops it is not scheduled to serve.
    nyctTrip('054900_2..S01R', '2', [['127S', civil('09:09:00')], ['128S', civil('09:11:00')], ['129S', civil('09:13:00')], ['130S', civil('09:15:00')], ['132S', civil('09:19:00')]], '09:09:00'),
    // Not in the published schedule at all.
    nyctTrip('055000_1..S03X001', '1', [['129S', civil('09:16:00')], ['130S', civil('09:18:00')]], '09:10:00'),
    // Where those trains are, as NYCT reports it: no coordinates.
    nyctVehicle('054800_1..S03R', '1', '127S', 1, stamp - 20, SERVICE_DATE, '01 0908 242/SFT'),
    nyctVehicle('054900_2..S01R', '2', '128S', 2, stamp - 30, SERVICE_DATE, '02 0909 241/FLA'),
    nyctVehicle('055000_1..S03X001', '1', '725S', 0, stamp - 10),
  ]);
  const documents: Record<string, Uint8Array> = { 'camsys/subway-alerts': feedBytes(stamp, []), ...nyctEquipmentDocuments() };
  for (const id of NYC_TRIP_FEEDS) documents[`nyct/${id}`] = id === 'gtfs' ? lines : feedBytes(stamp, []);
  return { ...documents, ...overrides } as Record<string, Uint8Array>;
}

async function nyc(documents = nycDocuments(), files = NYC_FILES) {
  quiet();
  const artifact = await bandedArtifact('nyc', undefined, files);
  const env = liveEnv(artifact.db);
  const hub = wireHub(env, artifact.db, 'nyc:mta');
  const network = upstream(documents);
  vi.spyOn(globalThis, 'fetch').mockImplementation(network.fetcher);
  await hub.alarm();
  return { ...artifact, env, hub, network };
}

describe('NYC subway through the global tools with every MTA feed', () => {
  it('answers the first departures question live when the coordinator holds only a stale snapshot', async () => {
    quiet();
    const artifact = await bandedArtifact('nyc');
    const env = liveEnv(artifact.db);
    wireHub(env, artifact.db, 'nyc:mta');
    const stamp = nowSeconds();
    await new RealtimeSnapshotStore(artifact.db.storage).publish('trip_updates', { version: artifact.version, producerTimestampSeconds: stamp - 3600, receivedAtSeconds: stamp - 3600, payload: [] });
    await artifact.db.storage.put('polled:trip_updates', stamp - 3600);
    // The provider answers 8 s after the question arrives: the live data is newer than the request.
    const network = upstream(nycDocuments(stamp + 8));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(stamp * 1000);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async request => { vi.setSystemTime((stamp + 8) * 1000); return network.fetcher(request as Request); });
    const result = (await callTool(env, 'get_departures', { stopRef: artifact.ref('stop', '127'), windowSeconds: 3600 })).structuredContent;
    vi.useRealTimers();
    expect(result).toMatchObject({ status: 'realtime' });
    expect(result.departures.some((row: { status: string }) => row.status === 'realtime')).toBe(true);
  });

  it('plans the first trip with live data when the provider answers after the question arrived', async () => {
    quiet();
    const artifact = await bandedArtifact('nyc');
    const env = liveEnv(artifact.db);
    wireHub(env, artifact.db, 'nyc:mta');
    const stamp = nowSeconds(), network = upstream(nycDocuments(stamp + 8));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(stamp * 1000);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async request => { vi.setSystemTime((stamp + 8) * 1000); return network.fetcher(request as Request); });
    const plan = (await callTool(env, 'plan_trip', { origin: { ref: artifact.ref('stop', '127') }, destination: { ref: artifact.ref('stop', '132') }, maxWalkMetres: 0 })).structuredContent;
    vi.useRealTimers();
    expect(plan.reasons).not.toContain('REALTIME_UNAVAILABLE');
    expect(plan.itineraries.length).toBeGreaterThan(0);
  });

  it('reports truthful NYC capabilities: live departures, alerts and train locations', async () => {
    const f = await nyc();
    const found = (await callTool(f.env, 'find_transit', { query: 'nyc' })).structuredContent;
    expect(found.coverages[0]).toMatchObject({ id: 'nyc', available: true,
      capabilities: { schedules: true, planning: true, realtimeDepartures: true, alerts: true, vehicles: true, accessibility: true } });
    const vehicles = (await callTool(f.env, 'get_vehicle_status', { ref: f.ref('route', '1') })).structuredContent;
    expect(vehicles).toMatchObject({ status: 'realtime', reasons: [] });
    expect(vehicles.vehicles.map((vehicle: { stopName: string; stopStatus: string }) => `${vehicle.stopName}:${vehicle.stopStatus}`)).toEqual(['Times Sq-42 St:stopped_at', 'Times Sq-42 St:incoming_at']);
    // Polled all nine documents with no credential attached; vehicles ride in the trip documents.
    expect(f.network.requests.map(request => decodeURIComponent(new URL(request.url).pathname).split('/').at(-1)).sort())
      .toEqual([...NYC_TRIP_FEEDS, 'subway-alerts', 'nyct_ene.json', 'nyct_ene_equipments.json'].sort());
  });

  it('shows which trains are at a station and where a dated train is, without inventing coordinates', async () => {
    const f = await nyc();
    // By name: both published Times Sq stations are one place.
    const atTimesSq = (await callTool(f.env, 'get_vehicle_status', { stop: 'Times Sq-42 St', coverage: 'nyc' })).structuredContent;
    expect(atTimesSq).toMatchObject({ status: 'realtime', vehicles: [
      { routeName: '1', trainId: '01 0908 242/SFT', headsign: 'South Ferry', stopStatus: 'stopped_at', stopRef: f.ref('stop', '127S'), stopName: 'Times Sq-42 St',
        previousStopRef: null, coordinates: { latitude: 40.75529, longitude: -73.987495 }, coordinatesSource: 'stop', ageSeconds: 20 },
      // Not in the schedule: no trip identity or headsign is invented, and it is not stopped, so no position.
      { routeName: '1', trainId: null, headsign: null, tripInstanceRef: null, stopStatus: 'incoming_at', stopRef: f.ref('stop', '725S'), coordinates: null, coordinatesSource: null },
    ] });
    // A dated trip from get_departures or plan_trip: the 2 has left Times Sq for 34 St.
    const express = formatTripInstanceRef({ coverage: 'nyc', feed: 'mta_subway', id: 'AFA25GEN-2092-Weekday-00_054900_2..S01R', serviceDate: SERVICE_DATE, startTime: '09:09:00' });
    expect((await callTool(f.env, 'get_vehicle_status', { ref: express })).structuredContent).toMatchObject({ status: 'realtime', vehicles: [
      { tripInstanceRef: express, routeName: '2', headsign: 'Flatbush Av-Brooklyn College', stopStatus: 'in_transit_to', stopName: '34 St-Penn Station',
        previousStopRef: f.ref('stop', '127S'), previousStopName: 'Times Sq-42 St', coordinates: null, coordinatesSource: null },
    ] });
    // A train ID resolves to the trip that train is running, whatever its case or spacing.
    const found = (await callTool(f.env, 'find_transit', { query: 'train 02  0909 241/fla', coverage: 'nyc' })).structuredContent;
    expect(found.candidates[0]).toMatchObject({ ref: express, kind: 'trip', name: 'Train 02 0909 241/FLA' });
    // A platform covers only itself.
    expect((await callTool(f.env, 'get_vehicle_status', { ref: f.ref('stop', '725S') })).structuredContent.vehicles.map((vehicle: { stopRef: string }) => vehicle.stopRef))
      .toEqual([f.ref('stop', '725S')]);
  });

  it('matches a short NYCT trip ID to the one scheduled trip it prefixes, and never an ambiguous one', async () => {
    // The 7, L and SIR publish `055400_1..S` for the scheduled `..._055400_1..S03R`.
    // Carried in another line's document, beside the other trains.
    const short = (stamp = nowSeconds()) => nycDocuments(stamp, { 'nyct/gtfs-l': feedBytes(stamp, [nyctTrip('055400_1..S', '1', [['129S', civil('09:18:30')]], '09:14:00')]) });
    const matched = await nyc(short());
    const row = (await callTool(matched.env, 'get_departures', { stopRef: matched.ref('stop', '129'), windowSeconds: 1800 })).structuredContent.departures
      .find((departure: Row) => tripId(departure) === 'AFA25GEN-1092-Weekday-00_055400_1..S03R');
    expect(row).toMatchObject({ scheduleMatch: 'matched', status: 'realtime', scheduledTime: expect.any(String) });
    expect(instant(row.predictedTime)).toBe(new Date(civil('09:18:30') * 1000).toISOString());
    // A second scheduled pattern with the same origin, line and direction: the short ID names neither.
    const files = { ...NYC_FILES,
      'trips.txt': NYC_FILES['trips.txt'] + '1,AFA25GEN-1092-Weekday-00_055400_1..S03X,Weekday,South Ferry,1\n',
      'stop_times.txt': NYC_FILES['stop_times.txt'] + 'AFA25GEN-1092-Weekday-00_055400_1..S03X,09:14:00,09:14:00,127S,1\nAFA25GEN-1092-Weekday-00_055400_1..S03X,09:20:00,09:20:00,129S,2\n' };
    const ambiguous = await nyc(short(), files);
    const rows = (await callTool(ambiguous.env, 'get_departures', { stopRef: ambiguous.ref('stop', '129'), windowSeconds: 1800 })).structuredContent.departures;
    expect(rows.filter((departure: Row) => instant(departure.predictedTime) === new Date(civil('09:18:30') * 1000).toISOString())
      .map((departure: Row) => [departure.scheduleMatch, departure.scheduledTime])).toEqual([['unmatched_trip', null]]);
  });

  it('sends an unchanged realtime payload once per isolate, with fresh metadata every read', async () => {
    const f = await nyc();
    const reads: { have: string | null; notModified: boolean; rows: number }[] = [];
    const original = f.hub.fetch.bind(f.hub);
    vi.spyOn(f.hub, 'fetch').mockImplementation(async (request: Request) => {
      const response = await original(request), url = new URL(request.url), body = await response.clone().json() as { notModified?: boolean; payload: unknown[] | null };
      if (url.pathname === '/trip_updates' && !url.searchParams.has('stop')) reads.push({ have: url.searchParams.get('have'), notModified: !!body.notModified, rows: body.payload?.length ?? 0 });
      return response;
    });
    const plan = () => callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', '127') }, destination: { ref: f.ref('stop', '132') }, maxWalkMetres: 0 });
    const first = (await plan()).structuredContent, second = (await plan()).structuredContent;
    expect(reads[0]).toMatchObject({ notModified: false });
    expect(reads[0]!.rows).toBeGreaterThan(0);
    expect(reads.at(-1)).toMatchObject({ have: expect.any(String), notModified: true, rows: 0 });
    expect(second.itineraries).toEqual(first.itineraries);
    expect(second.status).toBe(first.status);
  });

  it('plans step-free journeys only between accessible platforms, avoiding blocking elevator outages', async () => {
    type Leg = { kind: string; from: string; to: string };
    const stepFree = (f: Awaited<ReturnType<typeof nyc>>, to: string) => callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', '127') }, destination: { ref: f.ref('stop', to) }, accessibility: 'step_free' });
    const clear = await nyc();
    // MTA lists Times Sq (127) and 14 St (132) as accessible, 28 St (129) as not.
    const plan = (await stepFree(clear, '132')).structuredContent;
    expect(plan.itineraries.length).toBeGreaterThan(0);
    const accessible = new Set<string>(['127S', '128S', '132S'].map(id => clear.ref('stop', id)));
    expect(plan.itineraries.every((itinerary: { legs: Leg[] }) => itinerary.legs.every(leg => leg.kind !== 'transit' || accessible.has(leg.from) && accessible.has(leg.to)))).toBe(true);
    expect(plan.sources.map((source: { kind: string }) => source.kind)).toContain('equipment_outages');
    expect((await stepFree(clear, '129')).structuredContent).toMatchObject({ status: 'unavailable', reasons: ['ENDPOINT_NOT_STEP_FREE'], itineraries: [] });
    // Without a step-free requirement 28 St is reachable as before.
    expect((await callTool(clear.env, 'plan_trip', { origin: { ref: clear.ref('stop', '127') }, destination: { ref: clear.ref('stop', '129') } })).structuredContent.itineraries.length).toBeGreaterThan(0);

    // 14 St's only ADA elevator is out: no step-free journey can end there, and status says why.
    const down = await nyc(nycDocuments(nowSeconds(), nyctEquipmentDocuments([nyctOutage('EL132A'), nyctOutage('ES127C')])));
    expect((await stepFree(down, '132')).structuredContent).toMatchObject({ status: 'unavailable', reasons: ['ENDPOINT_NOT_STEP_FREE'] });
    const status = (await callTool(down.env, 'get_service_status', { ref: down.ref('stop', '132S') })).structuredContent;
    expect(status.equipment).toMatchObject({ status: 'current', count: 1, blockingStepFreeCount: 1, outages: [{ equipmentId: 'EL132A', kind: 'elevator', accessiblePath: true, hasBackup: false,
      blocksStepFree: true, upcoming: false, stationName: '14 St', alternativeRoute: 'Take a downtown 1 to Christopher St and an M8 bus back.', since: '2026-10-19T06:00:00-04:00' }] });
    // A station covers its complex: Times Sq by its 7 station lists the escalator, which does not block step-free travel.
    expect((await callTool(down.env, 'get_service_status', { ref: down.ref('stop', '725') })).structuredContent.equipment.outages)
      .toMatchObject([{ equipmentId: 'ES127C', kind: 'escalator', accessiblePath: false, blocksStepFree: false }]);

    // Times Sq's elevators back each other up: one out leaves a step-free path, both out do not.
    const one = await nyc(nycDocuments(nowSeconds(), nyctEquipmentDocuments([nyctOutage('EL127A')])));
    expect((await stepFree(one, '132')).structuredContent.itineraries.length).toBeGreaterThan(0);
    const both = await nyc(nycDocuments(nowSeconds(), nyctEquipmentDocuments([nyctOutage('EL127A'), nyctOutage('EL127B')])));
    expect((await stepFree(both, '132')).structuredContent).toMatchObject({ reasons: ['ENDPOINT_NOT_STEP_FREE'] });
    // Announced but not started: listed as upcoming, never blocking.
    const upcoming = await nyc(nycDocuments(nowSeconds(), nyctEquipmentDocuments([nyctOutage('EL132A', { upcoming: true, since: '10/19/2026 10:00:00 PM' })])));
    expect((await stepFree(upcoming, '132')).structuredContent.itineraries.length).toBeGreaterThan(0);
    expect((await callTool(upcoming.env, 'get_service_status', { coverage: 'nyc' })).structuredContent.equipment.outages).toMatchObject([{ equipmentId: 'EL132A', upcoming: true, blocksStepFree: false }]);
  });

  it('refuses a step-free plan without a current equipment report instead of guessing', async () => {
    const documents = nycDocuments();
    delete documents['nyct/nyct_ene_equipments.json'];
    const f = await nyc(documents);
    expect((await callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', '127') }, destination: { ref: f.ref('stop', '132') }, accessibility: 'step_free' })).structuredContent)
      .toMatchObject({ status: 'unavailable', itineraries: [], reasons: expect.arrayContaining(['ACCESSIBILITY_UNAVAILABLE']) });
    expect((await callTool(f.env, 'get_service_status', { coverage: 'nyc' })).structuredContent.equipment).toMatchObject({ status: 'unavailable', outages: [] });
  });

  it('labels platforms and stations with their step-free access, by direction', async () => {
    const f = await nyc();
    const rows = (await callTool(f.env, 'get_departures', { stop: 'Times Sq-42 St', coverage: 'nyc', windowSeconds: 1800 })).structuredContent.departures;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row: { stepFree: string }) => row.stepFree === 'accessible')).toBe(true);
    const at28 = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 1800 })).structuredContent.departures;
    expect(at28.every((row: { stepFree: string }) => row.stepFree === 'not_accessible')).toBe(true);
    expect((await callTool(f.env, 'find_transit', { ref: f.ref('stop', '129') })).structuredContent.entities[0].stepFree).toBe('not_accessible');
    expect((await callTool(f.env, 'find_transit', { ref: f.ref('stop', '132') })).structuredContent.entities[0].stepFree).toBe('accessible');
  });

  it('serves coordinator reads without rereading the artifact pointer from R2', async () => {
    const f = await nyc();
    const get = vi.spyOn(f.db.bucket, 'get');
    const pointerReads = () => get.mock.calls.filter(([key]) => key === 'artifacts/nyc/v2/current.json').length;
    await callTool(f.env, 'get_service_status', { coverage: 'nyc' });
    // The Worker resolves the published version once; the coordinator answers from its last poll.
    expect(pointerReads()).toBe(1);
  });

  it('plans along the lines a model names where an open search is withheld, and hints which lines could', async () => {
    const f = await nyc();
    (f.env as { TRANSIT_PLANNING_OFF?: string }).TRANSIT_PLANNING_OFF = '["nyc"]';
    const ask = (extra: Record<string, unknown> = {}) => callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', '127') }, destination: { ref: f.ref('stop', '132') }, maxWalkMetres: 0, ...extra });
    const refused = (await ask()).structuredContent;
    expect(refused).toMatchObject({ status: 'unavailable', reasons: ['PLANNING_UNAVAILABLE'], itineraries: [] });
    // Both the 1 and the 2 serve Times Sq and 14 St: one-seat rides.
    expect(refused.routeHints.direct.map((hint: { name: string }) => hint.name).sort()).toEqual(['1', '2']);
    expect(refused.routeHints.origin[0]).toMatchObject({ stopName: 'Times Sq-42 St', walkMetres: 0 });
    const guided = (await ask({ routes: [f.ref('route', '1')] })).structuredContent;
    expect(guided.itineraries.length).toBeGreaterThan(0);
    expect(guided.itineraries.flatMap((itinerary: { legs: { kind: string; routeRef?: string }[] }) => itinerary.legs.filter(leg => leg.kind === 'transit').map(leg => leg.routeRef)))
      .toEqual(guided.itineraries.map(() => f.ref('route', '1')));
    expect(guided.itineraries.every((itinerary: { legs: { validatorOutcome: string }[] }) => itinerary.legs.every(leg => leg.validatorOutcome === 'valid'))).toBe(true);
    // Riders read steps: one ride, named.
    expect(guided.itineraries[0].steps).toMatchObject([{ kind: 'ride', routeName: '1', fromName: 'Times Sq-42 St', toName: '14 St' }]);
    // Starting where the named line does not stop (Times Sq's 7 platform), the journey walks to it.
    const walked = (await callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', '725S') }, destination: { ref: f.ref('stop', '132') }, routes: [f.ref('route', '1')] })).structuredContent;
    expect(walked.itineraries.length).toBeGreaterThan(0);
    expect(walked.itineraries[0].steps.map((step: { kind: string }) => step.kind)).toEqual(['walk', 'ride']);
    expect(walked.itineraries[0].steps[0]).toMatchObject({ fromName: 'Times Sq-42 St', toName: 'Times Sq-42 St' });
    // A route from another coverage is not a proposal for this one.
    expect((await ask({ routes: ['tr:dc:wmata:route:UkVE'] })).structuredContent).toMatchObject({ code: 'INVALID_TRANSIT_REF' });
  });

  it('lists the next trips from A that reach B, each with its arrival there', async () => {
    const f = await nyc();
    type Row = { tripInstanceRef: string; routeName: string; scheduledTime: string; arrival: { stopName: string; scheduledTime: string | null; predictedTime: string | null } };
    const to14 = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '127'), toStopRef: f.ref('stop', '132'), windowSeconds: 3600 })).structuredContent.departures as Row[];
    expect(to14.length).toBeGreaterThan(0);
    expect(to14.every(row => row.arrival.stopName === '14 St' && Date.parse(row.arrival.scheduledTime!) > Date.parse(row.scheduledTime))).toBe(true);
    // The 1 skipping 23 and 18 St still reaches 14 St, predicted at 09:20.
    const local = to14.find(row => tripId(row as never) === 'AFA25GEN-1092-Weekday-00_054800_1..S03R')!;
    expect(local.arrival).toMatchObject({ scheduledTime: formatInstant(civil('09:18:00') * 1000, 'America/New_York'), predictedTime: formatInstant(civil('09:20:00') * 1000, 'America/New_York') });
    // The 2 express is not scheduled to stop at 28 St: it is not a way there.
    const to28 = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '127'), toStop: '28 St', coverage: 'nyc', windowSeconds: 3600 })).structuredContent.departures as Row[];
    expect(to28.length).toBeGreaterThan(0);
    expect(to28.every(row => row.routeName === '1')).toBe(true);
    // Without a destination nothing changes, and arrival is null.
    const board = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '127'), windowSeconds: 3600 })).structuredContent.departures as Row[];
    expect(board.every(row => row.arrival === null)).toBe(true);
  });

  it('never lets two live trains claim one scheduled trip, and plans around the contradiction', async () => {
    // NYCT published two 7 trains under one short ID; here two entities claim the scheduled 1 train.
    const stamp = nowSeconds();
    const claim = (id: string, time: number) => ({ ...nyctTrip('054800_1..S03R', '1', [['129S', time]], '09:09:41'), id });
    const f = await nyc(nycDocuments(stamp, { 'nyct/gtfs': feedBytes(stamp, [claim('A', civil('09:14:00')), claim('B', civil('09:21:00')),
      nyctTrip('055400_1..S03R', '1', [['129S', civil('09:19:00')]], '09:14:00')]) }));
    const rows = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 3600 })).structuredContent.departures as Row[];
    const claimed = rows.filter(row => tripId(row).endsWith('054800_1..S03R'));
    // Neither claim is presented as the scheduled trip.
    expect(claimed.every(row => row.scheduleMatch !== 'matched' || row.status === 'scheduled_only')).toBe(true);
    const plan = (await callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', '127') }, destination: { ref: f.ref('stop', '132') }, maxWalkMetres: 0 })).structuredContent;
    // The rest of the network still plans.
    expect(plan.itineraries.length).toBeGreaterThan(0);
  });

  it('checks a station by name, and names the station a departure reaches', async () => {
    const down = await nyc(nycDocuments(nowSeconds(), nyctEquipmentDocuments([nyctOutage('EL132A')])));
    const byName = (await callTool(down.env, 'get_service_status', { stop: '14 St', coverage: 'nyc' })).structuredContent;
    // Two stations are named 14 St: the agent is asked which, with candidates.
    expect(byName).toMatchObject({ code: 'ENTITY_AMBIGUOUS' });
    const timesSq = (await callTool(down.env, 'get_service_status', { stop: 'Times Sq-42 St', coverage: 'nyc' })).structuredContent;
    expect(timesSq).toMatchObject({ status: expect.any(String), equipment: expect.any(Object) });
    const rows = (await callTool(down.env, 'get_departures', { stopRef: down.ref('stop', '127S'), toStopRef: down.ref('stop', '132'), windowSeconds: 3600 })).structuredContent.departures;
    expect(rows.every((row: { arrival: { stopName: string } }) => row.arrival.stopName === '14 St')).toBe(true);
  });

  it('lists departures across every station of a complex', async () => {
    const f = await nyc();
    // 725 has no scheduled service of its own; the 1 and 2 leave from 127 in the same complex.
    const rows = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '725'), windowSeconds: 1800 })).structuredContent.departures;
    expect(new Set(rows.map((row: { routeName: string }) => row.routeName))).toEqual(new Set(['1', '2']));
    expect(rows.every((row: { stopName: string }) => row.stopName === 'Times Sq-42 St')).toBe(true);
  });

  it('keeps rerouted and unscheduled trains, and drops scheduled calls a train will not make', async () => {
    const f = await nyc();
    const at28 = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(at28.status).toBe('realtime');
    expect(at28.departures.map((row: Row) => [tripId(row), row.scheduleMatch, row.status, instant(row.predictedTime ?? row.scheduledTime)])).toEqual([
      // The rerouted 2 keeps its canonical scheduled identity at a stop it is not scheduled to serve.
      ['AFA25GEN-2092-Weekday-00_054900_2..S01R', 'unscheduled_call', 'realtime', '2026-10-19T13:13:00.000Z'],
      ['AFA25GEN-1092-Weekday-00_054800_1..S03R', 'matched', 'realtime', '2026-10-19T13:14:00.000Z'],
      ['055000_1..S03X001', 'unmatched_trip', 'realtime', '2026-10-19T13:16:00.000Z'],
      ['AFA25GEN-1092-Weekday-00_055400_1..S03R', 'matched', 'scheduled_only', '2026-10-19T13:18:00.000Z'],
    ]);
    const observed = at28.departures.filter((row: Row) => row.scheduleMatch !== 'matched');
    expect(observed.every((row: Row) => row.scheduledTime === null && row.stopSequence === null)).toBe(true);
    expect(observed.map((row: Row) => row.headsign)).toEqual(['14 St', '23 St']);
    expect(observed[0].tripInstanceRef).toBe(formatTripInstanceRef({ coverage: 'nyc', feed: 'mta_subway', id: 'AFA25GEN-2092-Weekday-00_054900_2..S01R', serviceDate: SERVICE_DATE, startTime: '09:09:00' }));

    const at23 = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '130'), windowSeconds: 1800 })).structuredContent;
    expect(at23.departures.map(tripId)).not.toContain('AFA25GEN-1092-Weekday-00_054800_1..S03R');
    expect(at23.departures.map((row: Row) => row.scheduleMatch)).toEqual(['unscheduled_call', 'unmatched_trip', 'matched']);
  });

  it('plans only from the schedule and avoids a stop the matched train will skip', async () => {
    const f = await nyc();
    const plan = (await callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', '127') }, destination: { ref: f.ref('stop', '130') }, maxWalkMetres: 0 })).structuredContent;
    const trips = plan.itineraries.flatMap((itinerary: { legs: { kind: string; tripRef?: string }[] }) => itinerary.legs.filter(leg => leg.kind === 'transit').map(leg => parseTransitRef(leg.tripRef!)!.id));
    expect(trips.length).toBeGreaterThan(0);
    expect(trips).not.toContain('AFA25GEN-1092-Weekday-00_054800_1..S03R');
    expect(trips.every((id: string) => id.startsWith('AFA25GEN-'))).toBe(true);
    // Station endpoints are satisfied at their own platforms; names of one station resolve to it.
    const byName = (await callTool(f.env, 'plan_trip', { coverage: 'nyc', origin: { query: 'Times Sq-42 St' }, destination: { query: '23 St' }, maxWalkMetres: 0 })).structuredContent;
    expect(byName.itineraries[0]).toMatchObject({ origin: f.ref('stop', '127'), destination: f.ref('stop', '130'),
      legs: [{ kind: 'transit', from: f.ref('stop', '127S'), to: f.ref('stop', '130S'), validatorOutcome: 'valid' }] });
  });

  it('fails closed to the schedule when any one MTA document is missing', async () => {
    const f = await nyc(Object.fromEntries(Object.entries(nycDocuments()).filter(([key]) => key !== 'nyct/gtfs-ace')));
    const result = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'scheduled_only', reasons: ['REALTIME_UNAVAILABLE'] });
    expect(result.departures.every((row: Row) => row.scheduleMatch === 'matched' && row.status === 'scheduled_only')).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"parts":["gtfs-ace"]'));
  });

  it('never refreshes a complete snapshot with a partial poll, so it ages into stale', async () => {
    const f = await nyc();
    vi.setSystemTime(Date.now() + 200_000);
    vi.spyOn(globalThis, 'fetch').mockImplementation(upstream(Object.fromEntries(Object.entries(nycDocuments()).filter(([key]) => key !== 'nyct/gtfs-l'))).fetcher);
    await f.hub.alarm();
    const result = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'scheduled_only', reasons: ['REALTIME_STALE'] });
    expect(result.departures.some((row: Row) => row.scheduleMatch !== 'matched')).toBe(false);
  });

  it('dates a merge by its oldest document, so one frozen line makes NYC realtime stale', async () => {
    const f = await nyc(nycDocuments(nowSeconds(), { 'nyct/gtfs-si': feedBytes(nowSeconds() - 300, []) }));
    const result = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'scheduled_only', reasons: ['REALTIME_STALE'] });
  });

  it('matches overnight service to its own service day after midnight', async () => {
    vi.setSystemTime(new Date('2026-10-20T00:20:00-04:00'));
    const stamp = nowSeconds();
    const documents = nycDocuments(stamp, { 'nyct/gtfs': feedBytes(stamp, [
      nyctTrip('146400_1..S03R', '1', [['127S', civil('00:25:00', '2026-10-20')], ['128S', civil('00:27:00', '2026-10-20')], ['129S', civil('00:29:00', '2026-10-20')],
        ['130S', civil('00:31:00', '2026-10-20')], ['131S', civil('00:33:00', '2026-10-20')], ['132S', civil('00:35:00', '2026-10-20')]], '24:24:00', SERVICE_DATE)]) });
    const f = await nyc(documents);
    const result = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(result.departures).toEqual([expect.objectContaining({ serviceDate: SERVICE_DATE, scheduleMatch: 'matched', status: 'realtime',
      scheduledTime: '2026-10-20T00:28:00-04:00', predictedTime: '2026-10-20T00:29:00-04:00' })]);
  });

  it.each([
    ['keeps its >24h origin, dated by calendar day', '146400_1..S03R', undefined],
    ['restarts the clock after midnight', '002400_1..S03R', '00:24:00'],
  ])('matches an after-midnight NYCT trip that %s to the previous service day', async (_label, tripId, startTime) => {
    vi.setSystemTime(new Date('2026-10-20T00:20:00-04:00'));
    const stamp = nowSeconds(), at = (time: string) => civil(time, '2026-10-20');
    const documents = nycDocuments(stamp, { 'nyct/gtfs': feedBytes(stamp, [{ id: tripId, tripUpdate: { trip: { tripId, routeId: '1', startDate: '20261020', ...(startTime ? { startTime } : {}) },
      stopTimeUpdate: [['127S', '00:25:00'], ['128S', '00:27:00'], ['129S', '00:29:30'], ['130S', '00:31:00'], ['131S', '00:33:00'], ['132S', '00:35:00']]
        .map(([stopId, time]) => ({ stopId, arrival: { time: at(time!) }, departure: { time: at(time!) } })) } }]) });
    const f = await nyc(documents);
    const result = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(result.departures).toEqual([expect.objectContaining({ serviceDate: SERVICE_DATE, scheduleMatch: 'matched', status: 'realtime',
      tripInstanceRef: formatTripInstanceRef({ coverage: 'nyc', feed: 'mta_subway', id: 'AFA25GEN-1092-Weekday-00_146400_1..S03R', serviceDate: SERVICE_DATE, startTime: '24:24:00' }),
      predictedTime: '2026-10-20T00:29:30-04:00' })]);
  });

  it('resolves MTA alert agency aliases and parent-station selectors for route and stop scopes', async () => {
    const stamp = nowSeconds();
    const alerts = feedBytes(stamp, [
      { id: 'lmm:planned_work:1', alert: { informedEntity: [{ agencyId: 'MTASBWY', routeId: '1', stopId: '129' }], headerText: { translation: [{ text: '[1] skips 28 St', language: 'en' }] } } },
      { id: 'lmm:alert:2', alert: { informedEntity: [{ agencyId: 'MTASBWY', routeId: 'F' }], headerText: { translation: [{ text: '[F] delays', language: 'en' }] } } },
    ]);
    const f = await nyc(nycDocuments(stamp, { 'camsys/subway-alerts': alerts }));
    const atStop = (await callTool(f.env, 'get_service_status', { ref: f.ref('stop', '129S') })).structuredContent;
    expect(atStop.status).toBe('realtime');
    expect(atStop.alerts.map((alert: { id: string }) => alert.id)).toEqual(['lmm:planned_work:1']);
    const onRoute = (await callTool(f.env, 'get_service_status', { ref: f.ref('route', 'F') })).structuredContent;
    expect(onRoute.alerts.map((alert: { id: string }) => alert.id)).toEqual(['lmm:alert:2']);
    expect(onRoute.alerts[0].agencyText).toEqual({ title: '[F] delays', description: '', label: 'agency_supplied' });
    const coverage = (await callTool(f.env, 'get_service_status', { coverage: 'nyc' })).structuredContent;
    expect(coverage.alerts).toHaveLength(2);
    expect(coverage.sources.map((source: { kind: string }) => source.kind)).toEqual(['gtfs_schedule', 'alerts', 'equipment_outages']);
  });

  it('never silently chooses between two stations with the same name', async () => {
    const f = await nyc();
    const found = (await callTool(f.env, 'find_transit', { query: '14 St', coverage: 'nyc' })).structuredContent;
    // Each station once (its platforms are represented by it), described so a model can choose.
    expect(new Set(found.candidates.filter((c: { kind: string }) => c.kind === 'stop').map((c: { providerId: string }) => c.providerId))).toEqual(new Set(['132', 'D19']));
    expect(found.candidates.find((c: { providerId: string }) => c.providerId === '132')).toMatchObject({ stopType: 'station', modes: ['subway'], routeNames: ['1', '2', 'F'] });
    const plan = await callTool(f.env, 'plan_trip', { coverage: 'nyc', origin: { query: '14 St' }, destination: { query: 'Times Sq-42 St' } });
    expect(plan.isError).toBe(true);
    expect(plan.structuredContent).toMatchObject({ code: 'ENTITY_AMBIGUOUS' });
    expect(plan.structuredContent.candidates.length).toBeGreaterThan(1);
  });

  it('answers "next train at <station>" in one call, resolving one station complex but never two places', async () => {
    const f = await nyc();
    const byName = (await callTool(f.env, 'get_departures', { stop: 'Times Sq-42 St', coverage: 'nyc', windowSeconds: 1800 })).structuredContent;
    expect(byName.status).toBe('realtime');
    expect(byName.departures[0]).toMatchObject({ stopName: 'Times Sq-42 St', routeName: expect.stringMatching(/^[12]$/) });
    expect(byName.departures.every((row: { routeName: string; stopName: string }) => row.routeName && row.stopName)).toBe(true);
    const ambiguous = await callTool(f.env, 'get_departures', { stop: '14 St', coverage: 'nyc' });
    expect(ambiguous).toMatchObject({ isError: true, structuredContent: { code: 'ENTITY_AMBIGUOUS' } });
    expect(new Set(ambiguous.structuredContent.candidates.map((c: { providerId: string }) => c.providerId))).toEqual(new Set(['132', 'D19']));
    expect(await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', '127'), stop: 'Times Sq-42 St', coverage: 'nyc' })).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_TRANSIT_REF' } });
    const plan = (await callTool(f.env, 'plan_trip', { coverage: 'nyc', origin: { query: 'Times Sq-42 St' }, destination: { query: '23 St' } })).structuredContent;
    expect(plan.itineraries.length).toBeGreaterThan(0);
  });

  it('keeps a city-wide alert readable: bounded detail with exact counts', async () => {
    const stamp = nowSeconds(), stops = ['127', '128', '129', '130', '131', '132', 'D19'];
    const informedEntity = Array.from({ length: 30 }, (_, index) => ({ agencyId: 'MTASBWY', routeId: '1', stopId: stops[index % stops.length], directionId: index % 2 }));
    const f = await nyc(nycDocuments(stamp, { 'camsys/subway-alerts': feedBytes(stamp, [{ id: 'wide', alert: { informedEntity, headerText: { translation: [{ text: '[1] planned work', language: 'en' }] } } }]) }));
    const [alert] = (await callTool(f.env, 'get_service_status', { coverage: 'nyc' })).structuredContent.alerts;
    expect(alert).toMatchObject({ selectorCount: 30, stopCount: 7, routeIds: ['1'] });
    expect(alert.selectors).toHaveLength(20);
    expect(alert.stopIds).toHaveLength(7);
  });

  it('rejects an edited itinerary instead of revalidating something plan_trip never returned', async () => {
    const f = await nyc();
    const result = await callTool(f.env, 'get_service_status', { itinerary: { coverageId: 'nyc', legs: 'not legs' } });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_ITINERARY' } });
  });

  it('serves schedules but no realtime claims when the first read cannot reach the provider', async () => {
    quiet();
    const artifact = await bandedArtifact('nyc');
    const env = liveEnv(artifact.db);
    wireHub(env, artifact.db, 'nyc:mta');
    // A first read polls the provider itself; when that fails it claims nothing live.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const result = (await callTool(env, 'get_departures', { stopRef: artifact.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'scheduled_only', reasons: ['REALTIME_UNAVAILABLE'] });
  });

  it('returns a structured outage when the schedule artifact is missing', async () => {
    quiet();
    const artifact = await bandedArtifact('nyc');
    for (const key of [...artifact.db.objects.keys()].filter(key => key.endsWith('.bin'))) artifact.db.objects.delete(key);
    // Earlier tests decoded these shards; a fresh isolate holds none.
    residentShards.clear();
    const env = liveEnv(artifact.db);
    const result = (await callTool(env, 'get_departures', { stopRef: artifact.ref('stop', '129') })).structuredContent;
    expect(result).toMatchObject({ status: 'unavailable', departures: [] });
  });
});

describe('Washington Metrorail through the global tools', () => {
  async function dc(entities: { trips?: transit_realtime.IFeedEntity[]; vehicles?: transit_realtime.IFeedEntity[]; alerts?: transit_realtime.IFeedEntity[]; incidents?: object[] } = {}, key = 'test-wmata-key') {
    quiet();
    const artifact = await bandedArtifact('dc');
    const env = liveEnv(artifact.db, { WMATA_API_KEY: key });
    const hub = wireHub(env, artifact.db, 'dc:wmata');
    const stamp = nowSeconds();
    const network = upstream({ 'rail-gtfsrt-tripupdates.pb': feedBytes(stamp, entities.trips ?? []), 'rail-gtfsrt-vehiclepositions.pb': feedBytes(stamp, entities.vehicles ?? []),
      'rail-gtfsrt-alerts.pb': feedBytes(stamp, entities.alerts ?? []), ...wmataIncidentDocument(entities.incidents) });
    vi.spyOn(globalThis, 'fetch').mockImplementation(network.fetcher);
    await hub.alarm();
    return { ...artifact, env, hub, network };
  }
  const red = { id: 'RED1', tripUpdate: { trip: { tripId: '14362694_20741', routeId: 'RED', startDate: SERVICE_DATE, startTime: '09:02:00', scheduleRelationship: 0 },
    stopTimeUpdate: [{ stopSequence: 2, stopId: 'PF_A02_C', departure: { delay: 120 } }] } };
  // WMATA non-revenue move: a route absent from the schedule, every stop skipped.
  const nonRevenue = { id: 'NR029', tripUpdate: { trip: { tripId: 'NR029', routeId: 'NR', startDate: SERVICE_DATE, startTime: '08:58:00', scheduleRelationship: 2 },
    stopTimeUpdate: [{ stopSequence: 1, stopId: 'PF_A02_C', scheduleRelationship: 1 }] } };

  it('authenticates with a header, never the URL, and reports live capabilities only with a key', async () => {
    const f = await dc();
    expect(f.network.requests).toHaveLength(4);
    expect(f.network.requests.every(request => request.headers.get('api_key') === 'test-wmata-key' && !request.url.includes('test-wmata-key'))).toBe(true);
    expect((await callTool(f.env, 'find_transit', { query: 'WMATA' })).structuredContent.coverages[0].capabilities)
      .toEqual({ schedules: true, planning: true, realtimeDepartures: true, alerts: true, vehicles: true, accessibility: true });
    const keyless = await dc({}, '');
    expect(keyless.network.requests).toHaveLength(0);
    expect((await callTool(keyless.env, 'find_transit', { query: 'dc' })).structuredContent.coverages[0].capabilities)
      .toMatchObject({ realtimeDepartures: false, alerts: false, vehicles: false, accessibility: false });
  });

  it('counts each elevator outage once, however many timetables the coverage has', async () => {
    quiet();
    const artifact = await bandedArtifact('dc');
    // Metrobus is a second timetable in the same coverage.
    await composeFeed(artifact.db, 'dc', 'wmata_bus', { 'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nMET,WMATA,https://wmata.com,America/New_York\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n1001,Bus Stop,38.9,-77.03\n1002,Other Stop,38.91,-77.03\n', 'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nX2,MET,X2,X2,3\n',
      'trips.txt': 'route_id,service_id,trip_id\nX2,D,X2_1\n', 'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nX2_1,09:00:00,09:00:00,1001,1\nX2_1,09:10:00,09:10:00,1002,2\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nD,1,1,1,1,1,1,1,20261001,20261231\n' });
    const env = liveEnv(artifact.db, { WMATA_API_KEY: 'test-wmata-key' });
    const hub = wireHub(env, artifact.db, 'dc:wmata'), stamp = nowSeconds();
    vi.spyOn(globalThis, 'fetch').mockImplementation(upstream({ 'rail-gtfsrt-tripupdates.pb': feedBytes(stamp, []), 'rail-gtfsrt-vehiclepositions.pb': feedBytes(stamp, []), 'rail-gtfsrt-alerts.pb': feedBytes(stamp, []),
      ...wmataIncidentDocument([wmataIncident('A01X01', 'A01', 'ELEVATOR', 'Street to mezzanine'), wmataIncident('A01X02', 'A01', 'ESCALATOR', 'Mezzanine to platform')]) }).fetcher);
    await hub.alarm();
    const equipment = (await callTool(env, 'get_service_status', { coverage: 'dc' })).structuredContent.equipment;
    expect(equipment.count).toBe(2);
    expect(equipment.outages.map((outage: { equipmentId: string }) => outage.equipmentId).sort()).toEqual(['A01X01', 'A01X02']);
  });

  it('plans step-free Metrorail journeys around station elevator outages, not garage ones', async () => {
    const stepFree = async (incidents: object[]) => {
      const f = await dc({ incidents });
      return { f, plan: (await callTool(f.env, 'plan_trip', { origin: { ref: f.ref('stop', 'STN_A03') }, destination: { ref: f.ref('stop', 'STN_A01') }, accessibility: 'step_free' })).structuredContent };
    };
    const clear = await stepFree([]);
    expect(clear.plan.itineraries.length).toBeGreaterThan(0);
    // The only elevator to Metro Center's platform is out.
    const down = await stepFree([wmataIncident('A01X01', 'A01', 'ELEVATOR', 'Elevator between street and mezzanine'), wmataIncident('A01X02', 'A01', 'ESCALATOR', 'Escalator between mezzanine and platform')]);
    expect(down.plan).toMatchObject({ status: 'unavailable', reasons: ['ENDPOINT_NOT_STEP_FREE'], itineraries: [] });
    const status = (await callTool(down.f.env, 'get_service_status', { ref: down.f.ref('stop', 'STN_A01') })).structuredContent.equipment;
    // WMATA omits the station name sometimes; the outage still lands on the station by code.
    expect(status).toMatchObject({ status: 'current', count: 2, blockingStepFreeCount: 1, outages: [
      { equipmentId: 'A01X01', kind: 'elevator', accessiblePath: true, hasBackup: null, blocksStepFree: true, stationRefs: [down.f.ref('stop', 'STN_A01')], since: '2026-10-19T06:00:00-04:00' },
      { equipmentId: 'A01X02', kind: 'escalator', accessiblePath: false, blocksStepFree: false }] });
    // A garage elevator does not reach the platforms.
    const garage = await stepFree([wmataIncident('A01X03', 'A01', 'ELEVATOR', 'Garage elevator')]);
    expect(garage.plan.itineraries.length).toBeGreaterThan(0);
  });

  it('applies predictions, excludes non-revenue moves from matching, and never offers unusable trips', async () => {
    const f = await dc({ trips: [red, nonRevenue] });
    const result = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', 'STN_A02'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'realtime', reasons: [] });
    expect(result.departures.map((row: Row) => [tripId(row), row.status, row.predictedTime])).toEqual([
      ['14362694_20741', 'realtime', '2026-10-19T09:06:00-04:00'],
      // No update for this trip: its scheduled call stays, marked scheduled_only.
      ['14362719_20741', 'scheduled_only', null],
    ]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"eligible":1,"matched":1,"rate":1,"nonRevenue":1'));
  });

  it('answers the first departures question live when the coordinator has not polled yet', async () => {
    quiet();
    const artifact = await bandedArtifact('dc');
    const env = liveEnv(artifact.db, { WMATA_API_KEY: 'test-wmata-key' });
    wireHub(env, artifact.db, 'dc:wmata');
    const stamp = nowSeconds();
    vi.spyOn(globalThis, 'fetch').mockImplementation(upstream({ 'rail-gtfsrt-tripupdates.pb': feedBytes(stamp, [red, nonRevenue]), 'rail-gtfsrt-vehiclepositions.pb': feedBytes(stamp, []),
      'rail-gtfsrt-alerts.pb': feedBytes(stamp, []), ...wmataIncidentDocument() }).fetcher);
    // An evicted coordinator still holds a long-stale stored snapshot; no alarm has run.
    await new RealtimeSnapshotStore(artifact.db.storage).publish('trip_updates', { version: artifact.version, producerTimestampSeconds: stamp - 3600,
      receivedAtSeconds: stamp - 3600, payload: [] });
    await artifact.db.storage.put('polled:trip_updates', stamp - 3600);
    // The question itself wakes the coordinator and is answered from what it fetches now.
    const result = (await callTool(env, 'get_departures', { stopRef: artifact.ref('stop', 'STN_A02'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'realtime', reasons: [] });
    expect(result.departures[0]).toMatchObject({ status: 'realtime', predictedTime: '2026-10-19T09:06:00-04:00' });
  });

  it('judges schedule identity by match rate only with enough trips, never by one late-night stray', async () => {
    const stray = (id: string) => ({ id, tripUpdate: { trip: { tripId: id, routeId: 'RED', startDate: SERVICE_DATE, startTime: '09:00:00', scheduleRelationship: 0 },
      stopTimeUpdate: [{ stopSequence: 1, stopId: 'PF_A03_C', departure: { time: civil('09:08:00') } }] } });
    const few = await dc({ trips: [red, stray('X1'), stray('X2'), stray('X3')] });
    expect((await callTool(few.env, 'get_departures', { stopRef: few.ref('stop', 'STN_A02'), windowSeconds: 1800 })).structuredContent).toMatchObject({ status: 'realtime', reasons: [] });
    const none = await dc({ trips: [stray('X1'), stray('X2')] });
    expect((await callTool(none.env, 'get_departures', { stopRef: none.ref('stop', 'STN_A02'), windowSeconds: 1800 })).structuredContent)
      .toMatchObject({ status: 'scheduled_only', reasons: ['SCHEDULE_REALTIME_MISMATCH'] });
  });

  it('locates an observed train only for a sufficiently specific dated trip or route', async () => {
    const vehicle = { id: 'V118', vehicle: { trip: { tripId: '14362694_20741', routeId: 'RED', startDate: SERVICE_DATE, startTime: '09:02:00', scheduleRelationship: 0 },
      position: { latitude: 38.905, longitude: -77.041, bearing: 120 }, timestamp: nowSeconds() - 10, vehicle: { id: '118', label: '644' } } };
    const f = await dc({ vehicles: [vehicle] });
    const instance = formatTripInstanceRef({ coverage: 'dc', feed: 'wmata', id: '14362694_20741', serviceDate: SERVICE_DATE, startTime: '09:02:00' });
    const byTrip = (await callTool(f.env, 'get_vehicle_status', { ref: instance })).structuredContent;
    // WMATA publishes "R" as the Red Line's short name; riders say "Red".
    expect(byTrip).toMatchObject({ status: 'realtime', vehicles: [{ id: '118', trainId: '644', tripInstanceRef: instance, routeName: 'Red', coordinatesSource: 'vehicle' }] });
    // GTFS-Realtime positions are float32.
    expect(byTrip.vehicles[0].coordinates.latitude).toBeCloseTo(38.905, 5);
    expect(byTrip.vehicles[0].coordinates.longitude).toBeCloseTo(-77.041, 5);
    const byRoute = (await callTool(f.env, 'get_vehicle_status', { ref: f.ref('route', 'RED') })).structuredContent;
    expect(byRoute.vehicles).toHaveLength(1);
    const other = formatTripInstanceRef({ coverage: 'dc', feed: 'wmata', id: '14362719_20741', serviceDate: SERVICE_DATE, startTime: '09:12:00' });
    expect((await callTool(f.env, 'get_vehicle_status', { ref: other })).structuredContent).toMatchObject({ status: 'unavailable', vehicles: [] });
    // A station lists trains reported at or heading to it; this one reports no stop.
    expect((await callTool(f.env, 'get_vehicle_status', { ref: f.ref('stop', 'STN_A02') })).structuredContent).toMatchObject({ status: 'realtime', vehicles: [] });
    // A bare train number is not a vehicle identity.
    expect((await callTool(f.env, 'get_vehicle_status', { ref: '118' })).structuredContent).toMatchObject({ code: 'INVALID_TRANSIT_REF' });
  });

  it('resolves a train number only through a fresh observation, listing every train that carries it', async () => {
    const observed = (id: string, trip: string, start: string) => ({ id: `V${trip}`, vehicle: { trip: { tripId: trip, routeId: 'RED', startDate: SERVICE_DATE, startTime: start, scheduleRelationship: 0 },
      position: { latitude: 38.905, longitude: -77.041 }, timestamp: nowSeconds() - 5, vehicle: { id, label: '644' } } });
    const f = await dc({ vehicles: [observed('118', '14362694_20741', '09:02:00')] });
    const found = (await callTool(f.env, 'find_transit', { query: 'train 118', coverage: 'dc' })).structuredContent;
    expect(found.candidates).toEqual([{ ref: formatTripInstanceRef({ coverage: 'dc', feed: 'wmata', id: '14362694_20741', serviceDate: SERVICE_DATE, startTime: '09:02:00' }),
      kind: 'trip', name: 'Train 118', coverage: 'dc', feed: 'wmata', providerId: '14362694_20741' }]);
    expect(found.sources.map((source: { kind: string }) => source.kind)).toContain('vehicle_positions');
    const twice = await dc({ vehicles: [observed('118', '14362694_20741', '09:02:00'), observed('118', '14362719_20741', '09:12:00')] });
    expect((await callTool(twice.env, 'find_transit', { query: '118', coverage: 'dc' })).structuredContent.candidates.map((c: { providerId: string }) => c.providerId))
      .toEqual(['14362694_20741', '14362719_20741']);
    // No fresh observation: no train identity is offered.
    vi.setSystemTime(Date.now() + 3_600_000);
    expect((await callTool(f.env, 'find_transit', { query: '118', coverage: 'dc' })).structuredContent.candidates).toEqual([]);
  });

  it('keeps WMATA alerts whose open period end is encoded as zero', async () => {
    const f = await dc({ alerts: [{ id: '7c875cc3', alert: { informedEntity: [{ routeId: 'RED' }], activePeriod: [{ start: nowSeconds() - 3600, end: 0 }],
      headerText: { translation: [{ text: 'Weekend Scheduled Maintenance', language: 'en' }] } } }] });
    const byRoute = (await callTool(f.env, 'get_service_status', { ref: f.ref('route', 'RED') })).structuredContent;
    expect(byRoute).toMatchObject({ status: 'realtime', alerts: [{ id: '7c875cc3', routeIds: ['RED'], activePeriods: [{ end: null }] }] });
  });
});

describe('NYC buses: one Bus Time relay, one coordinator per borough timetable', () => {
  const busFiles = (agency: string, route: string, trip: string, stops: [string, string, number, number][]) => ({
    'agency.txt': `agency_id,agency_name,agency_url,agency_timezone\n${agency},MTA New York City Transit,https://new.mta.info,America/New_York\n`,
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n' + stops.map(([id, name, lat, lon]) => `${id},${name},${lat},${lon}`).join('\n') + '\n',
    'routes.txt': `agency_id,route_id,route_short_name,route_long_name,route_type\n${agency},${route},${route},${route} local,3\n`,
    'trips.txt': `route_id,service_id,trip_id,trip_headsign\n${route},Weekday,${trip},Northbound\n`,
    'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${trip},09:05:00,09:05:00,${stops[0]![0]},1\n${trip},09:15:00,09:15:00,${stops[1]![0]},2\n`,
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWeekday,1,1,1,1,1,0,0,20261001,20261031\n',
  });
  it('fetches Bus Time once and has each borough publish only its own buses, live', async () => {
    quiet();
    const artifact = await bandedArtifact('nyc');
    await composeFeed(artifact.db, 'nyc', 'mta_bus_m', busFiles('MTA NYCT', 'M15', 'MV_M15_0905', [['401', '1 Av/E 14 St', 40.7317, -73.9818], ['402', '1 Av/E 23 St', 40.7366, -73.9784]]));
    await composeFeed(artifact.db, 'nyc', 'mta_bus_bx', busFiles('MTA NYCT', 'BX12', 'BX_BX12_0905', [['101', 'Fordham Rd/Grand Concourse', 40.8623, -73.8977], ['102', 'Fordham Rd/Webster Av', 40.8612, -73.8909]]));
    const env = liveEnv(artifact.db, { MTA_BUS_API_KEY: 'test-bus-key' } as never);
    const hubs = new Map<string, RegionFeedHub>();
    env.REGION_FEED_HUB = { idFromName: (name: string) => ({ toString: () => name }), get: (id: { toString(): string }) => ({
      fetch: (request: string | Request) => hubs.get(id.toString())?.fetch(typeof request === 'string' ? new Request(request) : request) ?? Promise.resolve(new Response(null, { status: 409 })) }) } as unknown as DurableObjectNamespace;
    for (const name of ['nyc:mta_bus', 'nyc:mta_bus_m', 'nyc:mta_bus_bx']) {
      const { storage } = memoryStorage();
      await storage.put('readAt', Number.MAX_SAFE_INTEGER); // a reader is present
      hubs.set(name, new RegionFeedHub({ id: { toString: () => name }, storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, env));
    }
    const stamp = nowSeconds();
    const trip = (tripId: string, routeId: string, stop: string, time: number) => ({ id: tripId, tripUpdate: { trip: { tripId, routeId, startDate: SERVICE_DATE }, stopTimeUpdate: [{ stopId: stop, stopSequence: 1, arrival: { time }, departure: { time } }] } });
    const network = upstream({ tripUpdates: feedBytes(stamp, [trip('MV_M15_0905', 'M15', '401', civil('09:07:00')), trip('BX_BX12_0905', 'BX12', '101', civil('09:06:00'))]),
      vehiclePositions: feedBytes(stamp, []), alerts: feedBytes(stamp, []) });
    vi.spyOn(globalThis, 'fetch').mockImplementation(network.fetcher);
    // The relay polls the provider; the boroughs read what it stored.
    await hubs.get('nyc:mta_bus')!.alarm();
    await hubs.get('nyc:mta_bus_m')!.alarm(); await hubs.get('nyc:mta_bus_bx')!.alarm();
    const paths = network.requests.map(request => new URL(request.url).pathname).sort();
    expect(paths).toEqual(['/alerts', '/tripUpdates', '/vehiclePositions']);
    expect(network.requests.every(request => new URL(request.url).searchParams.get('key') === 'test-bus-key')).toBe(true);
    const busStop = (feed: string, id: string) => formatEntityRef({ coverage: 'nyc', feed, kind: 'stop', id });
    const m15 = (await callTool(env, 'get_departures', { stopRef: busStop('mta_bus_m', '401'), windowSeconds: 3600 })).structuredContent;
    expect(m15).toMatchObject({ status: 'realtime', departures: [{ routeName: 'M15', status: 'realtime', predictedTime: formatInstant(civil('09:07:00') * 1000, 'America/New_York') }] });
    const bx12 = (await callTool(env, 'get_departures', { stopRef: busStop('mta_bus_bx', '101'), windowSeconds: 3600 })).structuredContent;
    expect(bx12).toMatchObject({ status: 'realtime', departures: [{ routeName: 'BX12', status: 'realtime', predictedTime: formatInstant(civil('09:06:00') * 1000, 'America/New_York') }] });
  });
});

describe('Metrobus beside Metrorail in one coverage', () => {
  // The bus stop PF_A02_C shares its ID with Farragut North's platform but is in Georgetown.
  const BUS_FILES = {
    'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\n1,WMATA,https://www.wmata.com,America/New_York\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nB1,Connecticut Av NW+Dupont Cir,38.90990,-77.04410\nPF_A02_C,Wisconsin Av NW+M St NW,38.90510,-77.06240\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nD80,1,D80,Union Station,3\n',
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,block_id\nD80,Weekday,9001,South to Union Station,A1\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n9001,09:03:00,09:03:00,B1,1\n9001,09:15:00,09:15:00,PF_A02_C,2\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWeekday,1,1,1,1,1,0,0,20261001,20261031\n',
  };
  async function dcWithBus() {
    quiet();
    const artifact = await bandedArtifact('dc');
    await composeFeed(artifact.db, 'dc', 'wmata_bus', BUS_FILES);
    const env = liveEnv(artifact.db, { WMATA_API_KEY: 'test-wmata-key' });
    const hub = wireHub(env, artifact.db, 'dc:wmata');
    const stamp = nowSeconds();
    vi.spyOn(globalThis, 'fetch').mockImplementation(upstream({ 'rail-gtfsrt-tripupdates.pb': feedBytes(stamp, []), 'rail-gtfsrt-vehiclepositions.pb': feedBytes(stamp, []),
      'rail-gtfsrt-alerts.pb': feedBytes(stamp, []) }).fetcher);
    await hub.alarm();
    return { ...artifact, env, bus: (id: string) => formatEntityRef({ coverage: 'dc', feed: 'wmata_bus', kind: 'stop', id }) };
  }

  it('keeps each feed’s stops apart even when their IDs collide', async () => {
    const f = await dcWithBus();
    const atBus = (await callTool(f.env, 'get_departures', { stopRef: f.bus('PF_A02_C'), windowSeconds: 3600 })).structuredContent;
    expect(atBus.departures.map((row: { routeName: string; stopName: string }) => `${row.routeName}@${row.stopName}`)).toEqual(['D80@Wisconsin Av NW+M St NW']);
    const atRail = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', 'STN_A02'), windowSeconds: 3600 })).structuredContent;
    expect(new Set(atRail.departures.map((row: { routeName: string }) => row.routeName))).toEqual(new Set(['Red']));
  });

  it('plans from a bus stop by walking to rail, never riding a feed it cannot search', async () => {
    const f = await dcWithBus();
    const plan = (await callTool(f.env, 'plan_trip', { origin: { ref: f.bus('B1') }, destination: { ref: f.ref('stop', 'STN_A01') }, departAt: '2026-10-19T09:00:00-04:00' })).structuredContent;
    expect(plan.itineraries.length).toBeGreaterThan(0);
    for (const itinerary of plan.itineraries) {
      expect(itinerary.origin).toEqual({ latitude: 38.9099, longitude: -77.0441 });
      expect(itinerary.legs[0]).toMatchObject({ kind: 'walk' });
      expect(itinerary.legs.filter((leg: { kind: string }) => leg.kind === 'transit').every((leg: { mode: string }) => leg.mode === 'subway')).toBe(true);
    }
  });
});
