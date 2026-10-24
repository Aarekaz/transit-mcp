import type { CoverageManifest } from '../transit/core/coverage';

const mta = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';
/** Every NYCT subway trip-update document. Lines are published separately, and a
 * train rerouted onto another line still reports in its own line's document. */
export const NYC_TRIP_FEEDS = ['gtfs', 'gtfs-ace', 'gtfs-bdfm', 'gtfs-g', 'gtfs-jz', 'gtfs-nqrw', 'gtfs-l', 'gtfs-si'] as const;
/** MTA publishes bus timetables per borough plus MTA Bus Company; Bus Time publishes one
 * realtime document for all of them. Archive names on rrgtfsfeeds. */
export const NYC_BUS_ARCHIVES = { mta_bus_bx: 'gtfs_bx', mta_bus_b: 'gtfs_b', mta_bus_m: 'gtfs_m', mta_bus_q: 'gtfs_q', mta_bus_si: 'gtfs_si', mta_bus_co: 'gtfs_busco' } as const;
export const NYC_BUS_FEEDS = Object.keys(NYC_BUS_ARCHIVES) as (keyof typeof NYC_BUS_ARCHIVES)[];
const busTime = 'https://gtfsrt.prod.obanyc.com';
/** Like Metrobus, NYC buses are too large for the planner; they serve departures, vehicles
 * and alerts, and a journey from a bus stop walks to rail. */
/** Bus Time publishes one document per kind for every borough; each timetable's coordinator
 * matches its own share of it (see the relay in the realtime sources). */
const busFeeds = NYC_BUS_FEEDS.map((id, index) => ({ id, planning: false as const, realtime: [
  { kind: 'trip_updates' as const, url: new URL(`${busTime}/tripUpdates`), weight: 4, minIntervalSeconds: 60, maxBytes: 8_000_000, timeoutMs: 15_000 },
  { kind: 'vehicle_positions' as const, url: new URL(`${busTime}/vehiclePositions`), weight: 2, minIntervalSeconds: 60, maxBytes: 4_000_000, timeoutMs: 10_000 },
  ...index > 0 ? [] : [{ kind: 'service_alerts' as const, url: new URL(`${busTime}/alerts`), weight: 1, minIntervalSeconds: 120, maxBytes: 4_000_000, timeoutMs: 10_000 }],
] }));

/** MTA supplemented subway GTFS (planned service changes for the coming days) and
 * NYCT GTFS-Realtime. NYCT vehicle entities ride in the trip feeds and report a stop
 * and status (stopped at, approaching, heading to), never coordinates. The Long Island
 * Rail Road and Metro-North share the coverage so a journey can change between them and
 * the subway (Penn Station, Atlantic Av, Jamaica, Grand Central, Harlem-125 St). */
export const NYC_COVERAGE = {
  id: 'nyc', kind: 'region', displayName: 'New York City Subway, LIRR and Metro-North',
  aliases: ['NYC', 'New York', 'New York City', 'NYC Subway', 'MTA Subway', 'MTA', 'LIRR', 'Long Island Rail Road', 'Metro-North', 'Metro-North Railroad'],
  // Railroad terminals and the subway stations beneath them, as each MTA GTFS names them.
  operators: [{ names: ['subway', 'MTA subway'], feeds: ['mta_subway'] }, { names: ['LIRR', 'Long Island Rail Road'], feeds: ['lirr'] }, { names: ['Metro-North', 'MNR'], feeds: ['mnr'] }],
  localities: ['New York', 'New York City', 'NYC', 'NY', 'Manhattan', 'Lower Manhattan', 'Midtown', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'],
  placeAliases: [
    { aliases: ['Penn Station', 'Penn', 'New York Penn Station'], stopNames: ['Penn Station', '34 St-Penn Station'] },
    { aliases: ['Grand Central', 'Grand Central Terminal', 'Grand Central Madison'], stopNames: ['Grand Central', 'Grand Central-42 St'] },
  ],
  feeds: [{ id: 'mta_subway', realtime: [
    { kind: 'trip_updates', parts: NYC_TRIP_FEEDS.map(id => ({ id, url: new URL(`${mta}/nyct%2F${id}`) })), alsoPublishes: ['vehicle_positions'],
      weight: 8, minIntervalSeconds: 30, maxBytes: 4_000_000, timeoutMs: 10_000 },
    { kind: 'service_alerts', url: new URL(`${mta}/camsys%2Fsubway-alerts`), weight: 1, minIntervalSeconds: 60, maxBytes: 8_000_000, timeoutMs: 10_000 },
    // Elevator/escalator outages (current and announced) and the equipment register that
    // places each unit on GTFS stations; both are required.
    { kind: 'equipment_outages', format: 'nyct_ene', accept: 'application/json', parts: [
      { id: 'outages', url: new URL(`${mta}/nyct%2Fnyct_ene.json`) }, { id: 'equipment', url: new URL(`${mta}/nyct%2Fnyct_ene_equipments.json`) }],
      weight: 1, minIntervalSeconds: 300, maxBytes: 4_000_000, timeoutMs: 15_000 },
  ] },
  // Vehicles ride in the trip document and carry GPS positions.
  { id: 'lirr', realtime: [
    { kind: 'trip_updates', url: new URL(`${mta}/lirr%2Fgtfs-lirr`), alsoPublishes: ['vehicle_positions'], weight: 4, minIntervalSeconds: 30, maxBytes: 4_000_000, timeoutMs: 10_000 },
    { kind: 'service_alerts', url: new URL(`${mta}/camsys%2Flirr-alerts`), weight: 1, minIntervalSeconds: 60, maxBytes: 4_000_000, timeoutMs: 10_000 },
  ] },
  // Metro-North vehicle entities carry neither a position nor a stop, so none are published.
  { id: 'mnr', realtime: [
    { kind: 'trip_updates', url: new URL(`${mta}/mnr%2Fgtfs-mnr`), weight: 4, minIntervalSeconds: 30, maxBytes: 4_000_000, timeoutMs: 10_000 },
    { kind: 'service_alerts', url: new URL(`${mta}/camsys%2Fmnr-alerts`), weight: 1, minIntervalSeconds: 60, maxBytes: 4_000_000, timeoutMs: 10_000 },
  ] },
  ...busFeeds],
  agencyTimezones: {}, timezone: 'America/New_York', supportedModes: ['subway', 'rail', 'bus'],
  // Montauk, New Haven and Poughkeepsie included.
  bounds: [-74.3, 40.45, -71.8, 41.8],
  capabilities: { schedules: true, planning: true, realtimeDepartures: true, alerts: true, vehicles: true, accessibility: true },
  thresholds: {
    tripUpdates: { realtimeSeconds: 180, staleSeconds: 600 },
    vehiclePositions: { realtimeSeconds: 360, unavailableSeconds: 600 },
    // Unmatched NYCT trains are kept as observed service, so this is only a schedule
    // identity check: a wrong or expired schedule matches far fewer trips.
    alerts: { currentSeconds: 1200 }, equipment: { currentSeconds: 900, expiredSeconds: 3600 }, minimumScheduleMatchRate: 0.5, maximumUnverifiedWalkMetres: 800,
  },
  attribution: [{ text: 'Transit data provided by the Metropolitan Transportation Authority.', url: 'https://www.mta.info/' }],
} as const satisfies CoverageManifest;
