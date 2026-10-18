import type { CoverageManifest } from '../transit/core/coverage';

/** The legacy MTA feed client is not a schedule-pinned snapshot publisher.
 * Global live capabilities stay unavailable until that ingestion contract exists. */
export const NYC_COVERAGE = {
  id: 'nyc', kind: 'region', displayName: 'New York City Subway',
  aliases: ['NYC', 'New York', 'New York City', 'NYC Subway', 'MTA Subway'],
  feeds: [{ id: 'mta_subway', realtime: [] }],
  agencyTimezones: {}, supportedModes: ['subway'],
  bounds: [-74.3, 40.45, -73.65, 40.95],
  capabilities: { schedules: true, planning: true, realtimeDepartures: false, alerts: false, vehicles: false, accessibility: false },
  thresholds: {
    tripUpdates: { realtimeSeconds: 180, staleSeconds: 600 },
    vehiclePositions: { realtimeSeconds: 360, unavailableSeconds: 600 },
    alerts: { currentSeconds: 1200 }, minimumScheduleMatchRate: 0.95, maximumUnverifiedWalkMetres: 800,
  },
  attribution: [{ text: 'Transit data provided by the Metropolitan Transportation Authority.', url: 'https://www.mta.info/' }],
} as const satisfies CoverageManifest;
