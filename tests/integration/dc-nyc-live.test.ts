import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatEntityRef } from '../../src/transit/core/refs';
import { sha256 } from '../../src/transit/gtfs/static/shards';
import { RegionFeedHub } from '../../src/transit/gtfs/realtime/region-feed-hub';
import { getRealtimeSource } from '../../src/transit/gtfs/realtime/sources';
import { memoryStorage } from '../helpers/realtime-fixture';
import { callTool, liveEnv } from '../helpers/dc-nyc-realtime';

/** Opt-in live acceptance: the real coordinator and tools against a built artifact and
 * the providers' live feeds. Network and provider state make it nondeterministic, so it
 * never runs by default. Prints evidence; asserts only contract invariants.
 *
 * TRANSIT_LIVE_COVERAGE=dc|nyc TRANSIT_LIVE_ARTIFACT_DIR=<built dir> [WMATA_API_KEY=...] bunx vitest run tests/integration/dc-nyc-live.test.ts */
const coverage = process.env.TRANSIT_LIVE_COVERAGE as 'dc' | 'nyc' | undefined;
const directory = process.env.TRANSIT_LIVE_ARTIFACT_DIR;
const STATIONS = { dc: ['STN_A01_C01', 'STN_A03', 'STN_B01_F01', 'STN_C05'], nyc: ['127', '635', 'D24', 'A32', 'R31'] };
const evidence = (label: string, value: Record<string, unknown>) => console.info(JSON.stringify({ label, ...value }));

describe.skipIf(!coverage || !directory)('live provider acceptance', () => {
  it(`serves ${coverage} from live feeds through the global tools`, { timeout: 120_000 }, async () => {
    const source = getRealtimeSource(coverage!)!;
    const db = memoryStorage();
    const walk = (path: string): string[] => readdirSync(path).flatMap(name => statSync(join(path, name)).isDirectory() ? walk(join(path, name)) : [join(path, name)]);
    for (const file of walk(join(directory!, 'artifacts'))) await db.bucket.put(file.slice(directory!.length + 1), new Uint8Array(readFileSync(file)));
    const version = await sha256(new Uint8Array(readFileSync(join(directory!, 'manifest.json'))));
    await db.bucket.put(`artifacts/${coverage}/v2/current.json`, JSON.stringify({ current: version }));
    const env = liveEnv(db, { WMATA_API_KEY: process.env.WMATA_API_KEY ?? '' });
    let hub!: RegionFeedHub;
    env.REGION_FEED_HUB = { idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: (request: string | Request) => hub.fetch(typeof request === 'string' ? new Request(request) : request) }) } as unknown as DurableObjectNamespace;
    hub = new RegionFeedHub({ id: { toString: () => source.policy.namespace }, storage: db.storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, env);
    const started = performance.now();
    await hub.alarm();
    evidence('poll', { coverage, artifactVersion: version, ms: Math.round(performance.now() - started), snapshots: [...db.values.keys()].filter(key => /^realtime:[a-z_]+$/.test(key)) });

    const ref = (kind: 'stop' | 'route', id: string) => formatEntityRef({ coverage: coverage!, feed: source.policy.feedId, kind, id });
    const capabilities = (await callTool(env, 'find_transit', { query: coverage! })).structuredContent.coverages[0];
    evidence('capabilities', capabilities);
    expect(capabilities.available).toBe(true);
    for (const id of STATIONS[coverage!]) {
      const result = (await callTool(env, 'get_departures', { stopRef: ref('stop', id), windowSeconds: 1800, limit: 12 })).structuredContent;
      const rows: Record<string, any>[] = result.departures;
      evidence(`departures:${id}`, { status: result.status, reasons: result.reasons, rows: rows.length, realtime: rows.filter(row => row.status === 'realtime').length,
        byMatch: Object.fromEntries(['matched', 'unscheduled_call', 'unmatched_trip'].map(kind => [kind, rows.filter(row => row.scheduleMatch === kind).length])),
        sources: result.sources.map((item: Record<string, any>) => `${item.kind}:${item.ageSeconds ?? '-'}s`),
        sample: rows.slice(0, 4).map(row => `${row.headsign}|${row.predictedTime ?? row.scheduledTime}|${row.scheduleMatch}`) });
      expect(['realtime', 'scheduled_only']).toContain(result.status);
      // Observed-only rows never carry an invented schedule.
      expect(rows.filter(row => row.scheduleMatch !== 'matched').every(row => row.scheduledTime === null && row.predictedTime !== null)).toBe(true);
    }
    const plan = (await callTool(env, 'plan_trip', { origin: { ref: ref('stop', STATIONS[coverage!][1]!) }, destination: { ref: ref('stop', STATIONS[coverage!][2]!) } })).structuredContent;
    evidence('plan', { status: plan.status, reasons: plan.reasons, itineraries: plan.itineraries.length, first: plan.itineraries[0] && {
      depart: plan.itineraries[0].departureTime, arrive: plan.itineraries[0].arrivalTime, transfers: plan.itineraries[0].transfers,
      legs: plan.itineraries[0].legs.map((leg: Record<string, any>) => leg.kind === 'transit' ? `transit:${leg.headsign}:${leg.status}` : `walk:${leg.verification}:${leg.distanceMetres}m`) } });
    expect(plan.itineraries.every((itinerary: Record<string, any>) => itinerary.legs.every((leg: Record<string, any>) => leg.validatorOutcome === 'valid'))).toBe(true);
    const alerts = (await callTool(env, 'get_service_status', { coverage: coverage! })).structuredContent;
    evidence('alerts', { status: alerts.status, reasons: alerts.reasons, alerts: alerts.alerts.length, sample: alerts.alerts.slice(0, 3).map((alert: Record<string, any>) => alert.agencyText.title.slice(0, 70)) });
    const route = coverage === 'dc' ? 'RED' : 'A';
    const routeAlerts = (await callTool(env, 'get_service_status', { ref: ref('route', route) })).structuredContent;
    evidence(`alerts:${route}`, { status: routeAlerts.status, alerts: routeAlerts.alerts.length });
    const vehicles = (await callTool(env, 'get_vehicle_status', { ref: ref('route', route), limit: 100 })).structuredContent;
    evidence('vehicles', { status: vehicles.status, reasons: vehicles.reasons, vehicles: vehicles.vehicles.length,
      onDatedTrip: vehicles.vehicles.filter((vehicle: Record<string, any>) => vehicle.tripInstanceRef).length,
      withStop: vehicles.vehicles.filter((vehicle: Record<string, any>) => vehicle.stopRef).length,
      withPrevious: vehicles.vehicles.filter((vehicle: Record<string, any>) => vehicle.previousStopRef).length });
    expect(vehicles.status).toBe('realtime');
    const station = (await callTool(env, 'get_vehicle_status', { ref: ref('stop', STATIONS[coverage!][0]!), limit: 100 })).structuredContent;
    evidence('vehicles:station', { status: station.status, vehicles: station.vehicles.length,
      sample: station.vehicles.slice(0, 6).map((vehicle: Record<string, any>) => `${vehicle.routeName}>${vehicle.headsign}|${vehicle.stopStatus}@${vehicle.stopName}|from:${vehicle.previousStopName}|${vehicle.coordinatesSource}|${vehicle.ageSeconds}s`) });
    const matched = vehicles.vehicles.find((vehicle: Record<string, any>) => vehicle.tripInstanceRef && vehicle.stopStatus === 'in_transit_to');
    if (matched) evidence('vehicles:trip', (await callTool(env, 'get_vehicle_status', { ref: matched.tripInstanceRef })).structuredContent.vehicles[0]);
    // NYCT publishes no train numbers (only an internal entity id), so only DC resolves one.
    const train = coverage === 'dc' ? vehicles.vehicles.find((vehicle: Record<string, any>) => vehicle.tripInstanceRef) : undefined;
    if (train) {
      const found = (await callTool(env, 'find_transit', { query: `train ${train.id}`, coverage: coverage! })).structuredContent;
      evidence('train', { query: train.id, candidates: found.candidates.map((candidate: Record<string, any>) => `${candidate.name}:${candidate.providerId}`) });
      expect(found.candidates.map((candidate: Record<string, any>) => candidate.ref)).toContain(train.tripInstanceRef);
      const byTrip = (await callTool(env, 'get_vehicle_status', { ref: train.tripInstanceRef })).structuredContent;
      evidence('vehicle-by-trip', { status: byTrip.status, vehicles: byTrip.vehicles.length });
    }
  });
});
