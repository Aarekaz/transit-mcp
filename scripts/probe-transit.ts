import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Protocol-level acceptance probe for a running deployment: /info, tools/list, every
 * global tool against representative DC and NYC stations, and every legacy tool.
 * Read-only. Prints structured evidence; exits 1 on any contract failure.
 *
 * bun scripts/probe-transit.ts <base-url> */
const base = new URL(process.argv[2] ?? 'http://localhost:8787');
const failures: string[] = [];
const check = (condition: unknown, message: string) => { if (!condition) failures.push(message); };
const log = (label: string, value: unknown) => console.info(JSON.stringify({ label, ...value as object }));

const GLOBAL = ['find_transit', 'plan_trip', 'get_departures', 'get_service_status', 'get_vehicle_status'];
const LEGACY = ['get_station_predictions', 'search_stations', 'get_stations_by_line', 'get_all_stations', 'get_station_transfers', 'get_incidents',
  'get_elevator_incidents', 'get_route_info', 'get_train_positions', 'get_bus_predictions', 'get_bus_routes', 'get_bus_stops', 'get_bus_positions'];

const info = await (await fetch(new URL('/info', base))).json() as Record<string, any>;
log('info', { tools: info.tools?.length ?? info.toolCount, name: info.name, version: info.version });

const client = new Client({ name: 'transit-mcp-probe', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
log('tools/list', { count: listed.length, tools: listed });
check(listed.length === 18, `tools/list returned ${listed.length} tools`);
for (const name of [...GLOBAL, ...LEGACY]) check(listed.includes(name), `tools/list is missing ${name}`);
const infoTools = (info.tools as (string | { name: string })[] | undefined)?.map(tool => typeof tool === 'string' ? tool : tool.name).sort();
if (infoTools) check(JSON.stringify(infoTools) === JSON.stringify(listed), '/info tools differ from tools/list');

async function call(name: string, args: Record<string, unknown>) {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; structuredContent?: Record<string, any>; content?: unknown[] };
  return { result, ms: Math.round(performance.now() - started) };
}
const summary = (value: Record<string, any> | undefined) => value && {
  status: value.status, reasons: value.reasons, code: value.code,
  sources: (value.sources ?? []).map((source: Record<string, any>) => `${source.feedId}:${source.kind}:${source.ageSeconds ?? '-'}s`),
};

// Exact GTFS parent stations: names such as "Times Sq-42 St" are several stations.
const stations = { dc: [['Dupont Circle', 'STN_A03'], ['Metro Center', 'STN_A01_C01'], ['Gallery Place', 'STN_B01_F01']],
  nyc: [['Times Sq-42 St', '127'], ['14 St-Union Sq', '635'], ['Atlantic Av-Barclays Ctr', 'D24']] } as const;
for (const coverage of ['dc', 'nyc'] as const) {
  const { result, ms } = await call('find_transit', { query: coverage });
  const capabilities = result.structuredContent?.coverages?.[0];
  log(`find_transit:${coverage}`, { ms, available: capabilities?.available, capabilities: capabilities?.capabilities });
  check(capabilities?.available === true, `${coverage} is not available`);
  const refs: string[] = [];
  for (const [name, id] of stations[coverage]) {
    const found = (await call('find_transit', { query: name, coverage })).result.structuredContent;
    const station = found?.candidates?.find((candidate: Record<string, any>) => candidate.kind === 'stop' && candidate.providerId === id);
    if (!station) { failures.push(`${coverage}: station not found: ${name}`); continue; }
    refs.push(station.ref);
    const departures = await call('get_departures', { stopRef: station.ref, windowSeconds: 3600, limit: 8 });
    const rows = departures.result.structuredContent?.departures ?? [];
    log(`get_departures:${coverage}:${name}`, { ms: departures.ms, ...summary(departures.result.structuredContent), count: rows.length,
      realtime: rows.filter((row: Record<string, any>) => row.status === 'realtime').length,
      observedOnly: rows.filter((row: Record<string, any>) => row.scheduleMatch !== 'matched').length,
      first: rows.slice(0, 3).map((row: Record<string, any>) => `${row.headsign}@${row.predictedTime ?? row.scheduledTime}/${row.scheduleMatch}`) });
    check(!departures.result.isError && ['realtime', 'scheduled_only'].includes(departures.result.structuredContent?.status), `${coverage} departures failed at ${name}`);
  }
  if (refs.length >= 2) {
    const plan = await call('plan_trip', { origin: { ref: refs[0] }, destination: { ref: refs[1] } });
    const itineraries = plan.result.structuredContent?.itineraries ?? [];
    log(`plan_trip:${coverage}`, { ms: plan.ms, ...summary(plan.result.structuredContent), itineraries: itineraries.length,
      first: itineraries[0] && { depart: itineraries[0].departureTime, arrive: itineraries[0].arrivalTime, transfers: itineraries[0].transfers,
        legs: itineraries[0].legs.map((leg: Record<string, any>) => `${leg.kind}:${leg.status ?? leg.verification}:${leg.validatorOutcome}`) } });
    check(itineraries.length > 0 && itineraries.every((itinerary: Record<string, any>) => itinerary.legs.every((leg: Record<string, any>) => leg.validatorOutcome === 'valid')), `${coverage} plan returned no validated itinerary`);
  }
  const status = await call('get_service_status', { coverage });
  log(`get_service_status:${coverage}`, { ms: status.ms, ...summary(status.result.structuredContent), alerts: status.result.structuredContent?.alerts?.length,
    sample: status.result.structuredContent?.alerts?.slice(0, 2).map((alert: Record<string, any>) => alert.agencyText.title.slice(0, 80)) });
  const route = (await call('find_transit', { query: coverage === 'dc' ? 'Red' : 'A', coverage })).result.structuredContent?.candidates?.find((c: Record<string, any>) => c.kind === 'route');
  if (route) {
    const vehicles = await call('get_vehicle_status', { ref: route.ref, limit: 5 });
    log(`get_vehicle_status:${coverage}:${route.name}`, { ms: vehicles.ms, ...summary(vehicles.result.structuredContent), vehicles: vehicles.result.structuredContent?.vehicles?.length });
    check(!vehicles.result.isError && vehicles.result.structuredContent?.status === 'realtime', `${coverage} vehicle status by line`);
  }
  const station = coverage === 'dc' ? 'Metro Center' : 'Times Sq-42 St';
  const atStation = await call('get_vehicle_status', { stop: station, coverage, limit: 20 });
  const trains: Record<string, any>[] = atStation.result.structuredContent?.vehicles ?? [];
  log(`get_vehicle_status:${coverage}:${station}`, { ms: atStation.ms, ...summary(atStation.result.structuredContent), vehicles: trains.length,
    sample: trains.slice(0, 5).map(train => `${train.routeName}>${train.headsign}|${train.stopStatus}@${train.stopName}|from:${train.previousStopName}|${train.coordinatesSource}`) });
  check(!atStation.result.isError && atStation.result.structuredContent?.status === 'realtime', `${coverage} vehicle status at a station`);
}

const legacy: [string, Record<string, unknown>][] = [
  ['get_station_predictions', { city: 'dc', stationName: 'A01' }], ['get_station_predictions', { city: 'nyc', stationName: '127' }],
  ['search_stations', { city: 'nyc', query: 'Union' }], ['get_stations_by_line', { city: 'dc', lineCode: 'RD' }], ['get_all_stations', { city: 'nyc' }],
  ['get_station_transfers', { city: 'nyc', stationId: '127' }], ['get_incidents', { city: 'dc' }], ['get_incidents', { city: 'nyc' }],
  ['get_elevator_incidents', { city: 'dc' }], ['get_route_info', { city: 'nyc', routeId: 'A' }], ['get_train_positions', {}],
  ['get_bus_routes', {}], ['get_bus_stops', { latitude: 38.8983, longitude: -77.0281, radius: 300 }], ['get_bus_positions', {}],
];
const stops = (await call('get_bus_stops', { latitude: 38.8983, longitude: -77.0281, radius: 300 })).result.structuredContent?.stops;
if (stops?.[0]) legacy.push(['get_bus_predictions', { stopId: stops[0].stopId ?? stops[0].id }]);
for (const [name, args] of legacy) {
  const { result, ms } = await call(name, args);
  log(`legacy:${name}`, { ms, args, isError: !!result.isError, structured: !!result.structuredContent, keys: Object.keys(result.structuredContent ?? {}).slice(0, 4) });
  check(!result.isError, `legacy ${name} ${JSON.stringify(args)} returned an error`);
}
check(new Set(legacy.map(([name]) => name)).size === 13, 'not every legacy tool was exercised');
await client.close();
console.info(JSON.stringify({ label: 'result', failures }));
if (failures.length) process.exit(1);
