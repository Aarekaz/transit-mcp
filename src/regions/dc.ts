import type { CoverageManifest } from '../transit/core/coverage';

const wmata = 'https://api.wmata.com/gtfs';

/** WMATA Metrorail GTFS and GTFS-Realtime. Realtime trip IDs equal static trip IDs, so
 * the published schedule must be refreshed with WMATA's short rolling feed window. */
export const DC_COVERAGE = {
  id: 'dc', kind: 'region', displayName: 'Washington DC Metro',
  aliases: ['DC', 'Washington DC', 'Washington, DC', 'WMATA', 'DC Metro'],
  placeAliases: [{ aliases: ['DCA', 'Reagan National Airport'], stopNames: ['Ronald Reagan Washington National Airport', 'Ronald Reagan Washington National Airport Metro Station'] }],
  feeds: [{ id: 'wmata', realtime: [
    { kind: 'trip_updates', url: new URL(`${wmata}/rail-gtfsrt-tripupdates.pb`), weight: 4, minIntervalSeconds: 30, maxBytes: 8_000_000, timeoutMs: 10_000 },
    { kind: 'vehicle_positions', url: new URL(`${wmata}/rail-gtfsrt-vehiclepositions.pb`), weight: 2, minIntervalSeconds: 30, maxBytes: 4_000_000, timeoutMs: 10_000 },
    { kind: 'service_alerts', url: new URL(`${wmata}/rail-gtfsrt-alerts.pb`), weight: 1, minIntervalSeconds: 120, maxBytes: 4_000_000, timeoutMs: 10_000 },
  ] }],
  agencyTimezones: {}, supportedModes: ['subway'],
  bounds: [-77.6, 38.6, -76.7, 39.3],
  // Pathways exist in the feed, but the planner has no verified step-free routing.
  capabilities: { schedules: true, planning: true, realtimeDepartures: true, alerts: true, vehicles: true, accessibility: false },
  thresholds: {
    tripUpdates: { realtimeSeconds: 180, staleSeconds: 600 },
    vehiclePositions: { realtimeSeconds: 360, unavailableSeconds: 600 },
    alerts: { currentSeconds: 1200 }, minimumScheduleMatchRate: 0.95, maximumUnverifiedWalkMetres: 800,
  },
  attribution: [{ text: 'Transit data provided by the Washington Metropolitan Area Transit Authority.', url: 'https://www.wmata.com/' }],
} as const satisfies CoverageManifest;
