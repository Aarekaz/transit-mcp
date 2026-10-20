import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatEntityRef } from '../../src/transit/core/refs';
import { sha256 } from '../../src/transit/gtfs/static/shards';
import { RegionFeedHub } from '../../src/transit/gtfs/realtime/region-feed-hub';
import { getRealtimeSource, getRealtimeSources, sourceFeedIds } from '../../src/transit/gtfs/realtime/sources';
import { memoryStorage } from '../helpers/realtime-fixture';
import { callTool, liveEnv } from '../helpers/dc-nyc-realtime';

/** Opt-in live acceptance: the real coordinator and tools against a built artifact and
 * the providers' live feeds. Network and provider state make it nondeterministic, so it
 * never runs by default. Prints evidence; asserts only contract invariants.
 *
 * TRANSIT_LIVE_COVERAGE=dc|nyc TRANSIT_LIVE_ARTIFACT_DIR=<built dir> [WMATA_API_KEY=...] [MTA_BUS_API_KEY=...] bunx vitest run tests/integration/dc-nyc-live.test.ts
 * Every feed of the coverage present in the artifact gets its own coordinator. */
const coverage = process.env.TRANSIT_LIVE_COVERAGE as 'dc' | 'nyc' | undefined;
const directory = process.env.TRANSIT_LIVE_ARTIFACT_DIR;
const STATIONS = { dc: ['STN_A01_C01', 'STN_A03', 'STN_B01_F01', 'STN_C05'], nyc: ['127', '635', 'D24', 'A32', 'R31'] };
const evidence = (label: string, value: Record<string, unknown>) => console.info(JSON.stringify({ label, ...value }));
/** A route (and optionally a stop) of each additional feed: vehicles, departures and alerts.
 * Without a stop, departures use the stop a live vehicle on the route is heading to. */
const FEED_PROBES: Record<string, { route: string; stop?: string }> = {
  lirr: { stop: '102', route: '1' }, mnr: { stop: '1', route: '3' }, wmata_bus: { stop: '6209', route: 'D80' },
  mta_bus_m: { route: 'M15' }, mta_bus_b: { route: 'B44' }, mta_bus_co: { route: 'Q19' }, mta_bus_bx: { route: 'BX12' },
};

describe.skipIf(!coverage || !directory)('live provider acceptance', () => {
  it(`serves ${coverage} from live feeds through the global tools`, { timeout: 120_000 }, async () => {
    const source = getRealtimeSource(coverage!)!;
    const db = memoryStorage();
    const walk = (path: string): string[] => readdirSync(path).flatMap(name => statSync(join(path, name)).isDirectory() ? walk(join(path, name)) : [join(path, name)]);
    for (const file of walk(join(directory!, 'artifacts'))) await db.bucket.put(file.slice(directory!.length + 1), new Uint8Array(readFileSync(file)));
    const version = await sha256(new Uint8Array(readFileSync(join(directory!, 'manifest.json'))));
    await db.bucket.put(`artifacts/${coverage}/v2/current.json`, JSON.stringify({ current: version }));
    const env = liveEnv(db, { WMATA_API_KEY: process.env.WMATA_API_KEY ?? '', ...(process.env.MTA_BUS_API_KEY ? { MTA_BUS_API_KEY: process.env.MTA_BUS_API_KEY } : {}) });
    // One coordinator per feed source, each with its own Durable Object storage.
    const manifest = JSON.parse(readFileSync(join(directory!, 'manifest.json'), 'utf8')) as { sources: { feedId: string }[] };
    const published = new Set(manifest.sources.map(item => item.feedId));
    const hubs = new Map<string, RegionFeedHub>();
    env.REGION_FEED_HUB = { idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({ fetch: (request: string | Request) => {
        const hub = hubs.get(id.toString());
        return hub ? hub.fetch(typeof request === 'string' ? new Request(request) : request) : Promise.resolve(new Response(null, { status: 409 }));
      } }) } as unknown as DurableObjectNamespace;
    for (const item of getRealtimeSources(coverage!).filter(item => sourceFeedIds(item.policy).some(feed => published.has(feed)))) {
      const storage = item.policy.namespace === source.policy.namespace ? db : memoryStorage();
      const hub = new RegionFeedHub({ id: { toString: () => item.policy.namespace }, storage: storage.storage, blockConcurrencyWhile: async (run: () => Promise<void>) => run() } as unknown as DurableObjectState, env);
      hubs.set(item.policy.namespace, hub);
      (globalThis as { gc?: () => void }).gc?.();
      const heap = process.memoryUsage().heapUsed, started = performance.now();
      await hub.alarm();
      evidence('poll', { coverage, namespace: item.policy.namespace, feeds: sourceFeedIds(item.policy), artifactVersion: version, ms: Math.round(performance.now() - started),
        heapMB: Math.round((process.memoryUsage().heapUsed - heap) / 1048576), snapshots: [...storage.values.keys()].filter(key => /^realtime:[a-z_]+$/.test(key)) });
    }

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
      sample: station.vehicles.slice(0, 6).map((vehicle: Record<string, any>) => `${vehicle.trainId}|${vehicle.routeName}>${vehicle.headsign}|${vehicle.stopStatus}@${vehicle.stopName}|from:${vehicle.previousStopName}|${vehicle.coordinatesSource}|${vehicle.ageSeconds}s`) });
    const matched = vehicles.vehicles.find((vehicle: Record<string, any>) => vehicle.tripInstanceRef && vehicle.stopStatus === 'in_transit_to');
    if (matched) evidence('vehicles:trip', (await callTool(env, 'get_vehicle_status', { ref: matched.tripInstanceRef })).structuredContent.vehicles[0]);
    const train = vehicles.vehicles.find((vehicle: Record<string, any>) => vehicle.tripInstanceRef && vehicle.trainId);
    expect(train).toBeDefined();
    if (train) {
      const found = (await callTool(env, 'find_transit', { query: `train ${train.trainId}`, coverage: coverage! })).structuredContent;
      evidence('train', { query: train.trainId, candidates: found.candidates.map((candidate: Record<string, any>) => `${candidate.name}:${candidate.providerId}`) });
      expect(found.candidates.map((candidate: Record<string, any>) => candidate.ref)).toContain(train.tripInstanceRef);
      const byTrip = (await callTool(env, 'get_vehicle_status', { ref: train.tripInstanceRef })).structuredContent;
      evidence('vehicle-by-trip', { status: byTrip.status, vehicles: byTrip.vehicles.length });
    }
    for (const [feed, probe] of Object.entries(FEED_PROBES).filter(([feed]) => published.has(feed))) {
      const feedRef = (kind: 'stop' | 'route', id: string) => formatEntityRef({ coverage: coverage!, feed, kind, id });
      const fleet = (await callTool(env, 'get_vehicle_status', { ref: feedRef('route', probe.route), limit: 100 })).structuredContent;
      evidence(`vehicles:${feed}:${probe.route}`, { status: fleet.status, reasons: fleet.reasons, code: fleet.code, vehicles: fleet.vehicles?.length,
        onDatedTrip: fleet.vehicles?.filter((vehicle: Record<string, any>) => vehicle.tripInstanceRef).length, sample: fleet.vehicles?.slice(0, 2).map((vehicle: Record<string, any>) => `${vehicle.trainId ?? vehicle.id}>${vehicle.headsign}|${vehicle.stopStatus}@${vehicle.stopName}|${vehicle.coordinatesSource}`) });
      const stopRef = probe.stop ? feedRef('stop', probe.stop) : fleet.vehicles?.find((vehicle: Record<string, any>) => vehicle.stopRef)?.stopRef;
      if (!stopRef) continue;
      const board = (await callTool(env, 'get_departures', { stopRef, windowSeconds: 3600, limit: 8 })).structuredContent;
      const rows: Record<string, any>[] = board.departures ?? [];
      evidence(`departures:${feed}`, { stop: rows[0]?.stopName ?? stopRef, status: board.status, reasons: board.reasons, code: board.code, rows: rows.length, realtime: rows.filter(row => row.status === 'realtime').length,
        sample: rows.slice(0, 4).map(row => `${row.routeName}>${row.headsign}|${(row.predictedTime ?? row.scheduledTime)?.slice(11, 16)}|${row.status}|track:${row.platform}`) });
      const status = (await callTool(env, 'get_service_status', { ref: feedRef('route', probe.route) })).structuredContent;
      evidence(`alerts:${feed}:${probe.route}`, { status: status.status, reasons: status.reasons, alerts: status.alerts?.length, sample: status.alerts?.slice(0, 2).map((alert: Record<string, any>) => alert.agencyText.title.slice(0, 60)) });
    }
  });
});
