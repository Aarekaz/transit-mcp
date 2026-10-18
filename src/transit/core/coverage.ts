import { SFBAY_COVERAGE } from '../../regions/sfbay';
import type { RealtimeFeedSpec, RegionMode } from '../../regions/types';
import type { TransitMode } from '../gtfs/static/modes';
import type { CoverageId } from './refs';
import type { TransitAttribution } from './results';

/** Binding names only. Credentials are supplied by the Worker runtime. */
export const COVERAGE_BINDINGS = {
  sfbay: { secretEnv: 'SF511_API_KEY', modeEnv: 'SFBAY_MODE' },
} as const;

export type CoverageBinding = typeof COVERAGE_BINDINGS[keyof typeof COVERAGE_BINDINGS];
export type CoverageWorkerBindings = {
  [Key in CoverageBinding['secretEnv']]?: string;
} & {
  [Key in CoverageBinding['modeEnv']]?: RegionMode;
};

/** Source support, independent of whether a coverage is publicly enabled. */
export interface CoverageCapability {
  schedules: boolean;
  realtimeDepartures: boolean;
  alerts: boolean;
  vehicles: boolean;
  planning: boolean;
  accessibility: boolean;
}

export interface CoverageManifest {
  id: CoverageId;
  kind: 'region' | 'operator' | 'national' | 'cross_border';
  displayName: string;
  aliases: readonly string[];
  /** Reviewed public place names only. Never client-specific home/work meanings. */
  placeAliases?: readonly { aliases: readonly string[]; stopNames: readonly string[] }[];
  feeds: readonly { id: string; realtime: readonly RealtimeFeedSpec[] }[];
  agencyTimezones: Readonly<Record<string, string>>;
  supportedModes: readonly TransitMode[];
  bounds?: readonly [west: number, south: number, east: number, north: number];
  capabilities: CoverageCapability;
  thresholds: {
    tripUpdates: { realtimeSeconds: number; staleSeconds: number };
    vehiclePositions: { realtimeSeconds: number; unavailableSeconds: number };
    alerts: { currentSeconds: number };
    minimumScheduleMatchRate: number;
    maximumUnverifiedWalkMetres: number;
  };
  attribution: readonly TransitAttribution[];
}

const coverages: readonly CoverageManifest[] = [SFBAY_COVERAGE];

/** Registry lookup does not enable a coverage or change legacy discovery. */
export function getCoverage(id: string): CoverageManifest | undefined {
  const normalized = id.trim().toLowerCase();
  return coverages.find(coverage => coverage.id === normalized ||
    coverage.displayName.toLowerCase() === normalized ||
    coverage.aliases.some(alias => alias.toLowerCase() === normalized));
}
