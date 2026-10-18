import type { SupportedCity } from '../transit/base';
import type { CoverageBinding } from '../transit/core/coverage';

export type PublicCity = SupportedCity | 'sfbay';
export type RegionMode = 'off' | 'dark' | 'on' | 'suspended';
export type RealtimeFeedKind = 'trip_updates' | 'vehicle_positions' | 'service_alerts';

export interface RealtimeFeedSpec {
  kind: RealtimeFeedKind;
  url: URL;
  weight: number;
  minIntervalSeconds: number;
  maxBytes: number;
  timeoutMs: number;
}

export interface RegionManifest {
  id: Exclude<PublicCity, SupportedCity>;
  displayName: string;
  timezone: string;
  bounds: readonly [west: number, south: number, east: number, north: number];
  idStrategy: 'verbatim' | 'agency-prefix';
  secretEnv: CoverageBinding['secretEnv'];
  modeEnv: CoverageBinding['modeEnv'];
  realtime: {
    budget: {
      requestsPerHour: number;
      safetyFactor: number;
      reserveForStatic: number;
    };
    feeds: readonly RealtimeFeedSpec[];
  };
  static: {
    artifactPrefix: string;
    maxStaticAgeDays: number;
  };
  attribution: {
    text: string;
    url: string;
  };
}
