import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { NYC_TRIP_FEEDS } from '../../src/regions/nyc';
import { formatTripInstanceRef, parseTransitRef } from '../../src/transit/core/refs';
import { NOW, NYC_FILES, SERVICE_DATE, bandedArtifact, callTool, civil, feedBytes, liveEnv, nowSeconds, nyctTrip, nyctVehicle, upstream, wireHub } from '../helpers/dc-nyc-realtime';

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
  const documents: Record<string, Uint8Array> = { 'camsys/subway-alerts': feedBytes(stamp, []) };
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
  it('reports truthful NYC capabilities: live departures, alerts and train locations', async () => {
    const f = await nyc();
    const found = (await callTool(f.env, 'find_transit', { query: 'nyc' })).structuredContent;
    expect(found.coverages[0]).toMatchObject({ id: 'nyc', available: true,
      capabilities: { schedules: true, planning: true, realtimeDepartures: true, alerts: true, vehicles: true, accessibility: false } });
    const vehicles = (await callTool(f.env, 'get_vehicle_status', { ref: f.ref('route', '1') })).structuredContent;
    expect(vehicles).toMatchObject({ status: 'realtime', reasons: [] });
    expect(vehicles.vehicles.map((vehicle: { stopName: string; stopStatus: string }) => `${vehicle.stopName}:${vehicle.stopStatus}`)).toEqual(['Times Sq-42 St:stopped_at', 'Times Sq-42 St:incoming_at']);
    // Polled all nine documents with no credential attached; vehicles ride in the trip documents.
    expect(f.network.requests.map(request => decodeURIComponent(new URL(request.url).pathname).split('/').at(-1)).sort())
      .toEqual([...NYC_TRIP_FEEDS, 'subway-alerts'].sort());
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
      scheduledTime: '2026-10-20T00:28:00-04:00', predictedTime: '2026-10-20T04:29:00.000Z' })]);
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
      predictedTime: '2026-10-20T04:29:30.000Z' })]);
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
    expect(coverage.sources.map((source: { kind: string }) => source.kind)).toEqual(['gtfs_schedule', 'alerts']);
  });

  it('never silently chooses between two stations with the same name', async () => {
    const f = await nyc();
    const found = (await callTool(f.env, 'find_transit', { query: '14 St', coverage: 'nyc' })).structuredContent;
    expect(new Set(found.candidates.filter((c: { kind: string }) => c.kind === 'stop').map((c: { providerId: string }) => c.providerId))).toEqual(new Set(['132', '132S', 'D19', 'D19S']));
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

  it('serves schedules but no realtime claims when the coordinator has not polled', async () => {
    quiet();
    const artifact = await bandedArtifact('nyc');
    const env = liveEnv(artifact.db);
    wireHub(env, artifact.db, 'nyc:mta');
    const result = (await callTool(env, 'get_departures', { stopRef: artifact.ref('stop', '129'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'scheduled_only', reasons: ['REALTIME_UNAVAILABLE'] });
  });

  it('returns a structured outage when the schedule artifact is missing', async () => {
    quiet();
    const artifact = await bandedArtifact('nyc');
    for (const key of [...artifact.db.objects.keys()].filter(key => key.endsWith('.bin'))) artifact.db.objects.delete(key);
    const env = liveEnv(artifact.db);
    const result = (await callTool(env, 'get_departures', { stopRef: artifact.ref('stop', '129') })).structuredContent;
    expect(result).toMatchObject({ status: 'unavailable', departures: [] });
  });
});

describe('Washington Metrorail through the global tools', () => {
  async function dc(entities: { trips?: transit_realtime.IFeedEntity[]; vehicles?: transit_realtime.IFeedEntity[]; alerts?: transit_realtime.IFeedEntity[] } = {}, key = 'test-wmata-key') {
    quiet();
    const artifact = await bandedArtifact('dc');
    const env = liveEnv(artifact.db, { WMATA_API_KEY: key });
    const hub = wireHub(env, artifact.db, 'dc:wmata');
    const stamp = nowSeconds();
    const network = upstream({ 'rail-gtfsrt-tripupdates.pb': feedBytes(stamp, entities.trips ?? []), 'rail-gtfsrt-vehiclepositions.pb': feedBytes(stamp, entities.vehicles ?? []),
      'rail-gtfsrt-alerts.pb': feedBytes(stamp, entities.alerts ?? []) });
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
    expect(f.network.requests).toHaveLength(3);
    expect(f.network.requests.every(request => request.headers.get('api_key') === 'test-wmata-key' && !request.url.includes('test-wmata-key'))).toBe(true);
    expect((await callTool(f.env, 'find_transit', { query: 'WMATA' })).structuredContent.coverages[0].capabilities)
      .toEqual({ schedules: true, planning: true, realtimeDepartures: true, alerts: true, vehicles: true, accessibility: false });
    const keyless = await dc({}, '');
    expect(keyless.network.requests).toHaveLength(0);
    expect((await callTool(keyless.env, 'find_transit', { query: 'dc' })).structuredContent.coverages[0].capabilities)
      .toMatchObject({ realtimeDepartures: false, alerts: false, vehicles: false });
  });

  it('applies predictions, excludes non-revenue moves from matching, and never offers unusable trips', async () => {
    const f = await dc({ trips: [red, nonRevenue] });
    const result = (await callTool(f.env, 'get_departures', { stopRef: f.ref('stop', 'STN_A02'), windowSeconds: 1800 })).structuredContent;
    expect(result).toMatchObject({ status: 'realtime', reasons: [] });
    expect(result.departures.map((row: Row) => [tripId(row), row.status, row.predictedTime])).toEqual([
      ['14362694_20741', 'realtime', '2026-10-19T13:06:00.000Z'],
      // No update for this trip: its scheduled call stays, marked scheduled_only.
      ['14362719_20741', 'scheduled_only', null],
    ]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"eligible":1,"matched":1,"rate":1,"nonRevenue":1'));
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
