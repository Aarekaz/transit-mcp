import type { RegionManifest } from './types';

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
