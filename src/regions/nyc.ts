import type { CoverageManifest } from '../transit/core/coverage';

const mta = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';
/** Every NYCT subway trip-update document. Lines are published separately, and a
 * train rerouted onto another line still reports in its own line's document. */
export const NYC_TRIP_FEEDS = ['gtfs', 'gtfs-ace', 'gtfs-bdfm', 'gtfs-g', 'gtfs-jz', 'gtfs-nqrw', 'gtfs-l', 'gtfs-si'] as const;

/** MTA supplemented subway GTFS (planned service changes for the coming days) and
 * NYCT GTFS-Realtime. Vehicle entities carry a stop and status, not coordinates, so
 * observed vehicle locations are not offered. */
export const NYC_COVERAGE = {
  id: 'nyc', kind: 'region', displayName: 'New York City Subway',
  aliases: ['NYC', 'New York', 'New York City', 'NYC Subway', 'MTA Subway'],
  feeds: [{ id: 'mta_subway', realtime: [
    { kind: 'trip_updates', parts: NYC_TRIP_FEEDS.map(id => ({ id, url: new URL(`${mta}/nyct%2F${id}`) })),
      weight: 8, minIntervalSeconds: 30, maxBytes: 4_000_000, timeoutMs: 10_000 },
    { kind: 'service_alerts', url: new URL(`${mta}/camsys%2Fsubway-alerts`), weight: 1, minIntervalSeconds: 60, maxBytes: 8_000_000, timeoutMs: 10_000 },
  ] }],
  agencyTimezones: {}, supportedModes: ['subway'],
  bounds: [-74.3, 40.45, -73.65, 40.95],
  capabilities: { schedules: true, planning: true, realtimeDepartures: true, alerts: true, vehicles: false, accessibility: false },
  thresholds: {
    tripUpdates: { realtimeSeconds: 180, staleSeconds: 600 },
    vehiclePositions: { realtimeSeconds: 360, unavailableSeconds: 600 },
    // Unmatched NYCT trains are kept as observed service, so this is only a schedule
    // identity check: a wrong or expired schedule matches far fewer trips.
    alerts: { currentSeconds: 1200 }, minimumScheduleMatchRate: 0.5, maximumUnverifiedWalkMetres: 800,
  },
  attribution: [{ text: 'Transit data provided by the Metropolitan Transportation Authority.', url: 'https://www.mta.info/' }],
} as const satisfies CoverageManifest;
