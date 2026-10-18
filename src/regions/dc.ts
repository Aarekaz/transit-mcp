import type { CoverageManifest } from '../transit/core/coverage';

/** Schedule-backed global coverage. Native WMATA APIs remain legacy overlays:
 * their IDs and observations are not yet pinned to canonical schedule snapshots. */
export const DC_COVERAGE = {
  id: 'dc', kind: 'region', displayName: 'Washington DC Metro',
  aliases: ['DC', 'Washington DC', 'Washington, DC', 'WMATA', 'DC Metro'],
  placeAliases: [{ aliases: ['DCA', 'Reagan National Airport'], stopNames: ['Ronald Reagan Washington National Airport', 'Ronald Reagan Washington National Airport Metro Station'] }],
  feeds: [{ id: 'wmata', realtime: [] }],
  agencyTimezones: {}, supportedModes: ['subway'],
  bounds: [-77.6, 38.6, -76.7, 39.3],
  capabilities: { schedules: true, planning: true, realtimeDepartures: false, alerts: false, vehicles: false, accessibility: false },
  thresholds: {
    tripUpdates: { realtimeSeconds: 180, staleSeconds: 600 },
    vehiclePositions: { realtimeSeconds: 360, unavailableSeconds: 600 },
    alerts: { currentSeconds: 1200 }, minimumScheduleMatchRate: 0.95, maximumUnverifiedWalkMetres: 800,
  },
  attribution: [{ text: 'Transit data provided by the Washington Metropolitan Area Transit Authority.', url: 'https://www.wmata.com/' }],
} as const satisfies CoverageManifest;
