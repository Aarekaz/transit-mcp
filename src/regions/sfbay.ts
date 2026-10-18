import type { RegionManifest } from './types';
import type { CoverageManifest } from '../transit/core/coverage';

const transitBase = 'https://api.511.org/transit';

export const SFBAY_REGION = {
  id: 'sfbay',
  displayName: 'San Francisco Bay Area',
  timezone: 'America/Los_Angeles',
  bounds: [-123.2, 36.8, -121.0, 38.9],
  idStrategy: 'verbatim',
  secretEnv: 'SF511_API_KEY',
  modeEnv: 'SFBAY_MODE',
  realtime: {
    budget: {
      requestsPerHour: 60,
      safetyFactor: 0.8,
      reserveForStatic: 1,
    },
    feeds: [
      { kind: 'trip_updates', url: new URL(`${transitBase}/tripupdates?agency=RG`), weight: 5, minIntervalSeconds: 120, maxBytes: 32_000_000, timeoutMs: 10_000 },
      { kind: 'vehicle_positions', url: new URL(`${transitBase}/vehiclepositions?agency=RG`), weight: 2, minIntervalSeconds: 300, maxBytes: 32_000_000, timeoutMs: 10_000 },
      { kind: 'service_alerts', url: new URL(`${transitBase}/servicealerts?agency=RG`), weight: 1, minIntervalSeconds: 900, maxBytes: 16_000_000, timeoutMs: 10_000 },
    ],
  },
  static: {
    artifactPrefix: 'artifacts/sfbay',
    maxStaticAgeDays: 14,
  },
  attribution: {
    text: 'Transit data provided by 511 SF Bay and participating Bay Area operators.',
    url: 'https://511.org/open-data/transit',
  },
} as const satisfies RegionManifest;

export const SFBAY_COVERAGE = {
  id: SFBAY_REGION.id,
  kind: 'region',
  displayName: SFBAY_REGION.displayName,
  aliases: ['SF', 'San Francisco', 'Bay Area'],
  feeds: [{ id: 'sf511', realtime: SFBAY_REGION.realtime.feeds }],
  // Populated from actual agency IDs by the schedule compiler, not feed IDs.
  agencyTimezones: {},
  supportedModes: ['tram', 'subway', 'rail', 'bus', 'ferry', 'cable_tram', 'trolleybus'],
  bounds: SFBAY_REGION.bounds,
  capabilities: { schedules: true, realtimeDepartures: true, alerts: true, vehicles: true, planning: true, accessibility: true },
  thresholds: {
    tripUpdates: { realtimeSeconds: 180, staleSeconds: 600 },
    vehiclePositions: { realtimeSeconds: 360, unavailableSeconds: 600 },
    alerts: { currentSeconds: 1200 },
    minimumScheduleMatchRate: 0.95,
    maximumUnverifiedWalkMetres: 800,
  },
  attribution: [SFBAY_REGION.attribution],
} as const satisfies CoverageManifest;
