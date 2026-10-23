import { SFBAY_COVERAGE } from '../../regions/sfbay';
import { DC_COVERAGE } from '../../regions/dc';
import { NYC_COVERAGE } from '../../regions/nyc';
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
} & {
  /** JSON object of known coverage IDs to rollout modes. New coverage defaults off.
   * SFBAY_MODE remains authoritative for SF and its existing ingestion coordinator. */
  TRANSIT_COVERAGE_MODES?: string;
  /** JSON array of coverage IDs whose whole-feed journey search is withheld: their
   * departures, alerts and vehicles stay on, and plan_trip plans only through the network
   * planner where TRANSIT_NETWORK_PLANNING enables it, else says PLANNING_UNAVAILABLE. */
  TRANSIT_PLANNING_OFF?: string;
  /** JSON array of coverage IDs where plan_trip first searches the whole network (buses
   * included) over compact timetables the cron builds. Unset or malformed: nowhere. */
  TRANSIT_NETWORK_PLANNING?: string;
};

/** Whether this deployment withholds journey planning for a coverage. Malformed is off for all. */
export function planningWithheld(id: string, bindings: CoverageWorkerBindings): boolean {
  try {
    const off: unknown = JSON.parse(bindings.TRANSIT_PLANNING_OFF ?? '[]');
    return !Array.isArray(off) || off.includes(id);
  } catch { return true; }
}

/** Whether plan_trip may use the network planner for a coverage. Malformed is off for all. */
export function networkPlanning(id: string, bindings: CoverageWorkerBindings): boolean {
  try {
    const on: unknown = JSON.parse(bindings.TRANSIT_NETWORK_PLANNING ?? '[]');
    return Array.isArray(on) && on.includes(id);
  } catch { return false; }
}

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
  /** Names riders add for an operator ("16th St Mission BART"): its agency IDs or feeds. */
  operators?: readonly { names: readonly string[]; agencies?: readonly string[]; feeds?: readonly string[] }[];
  /** `planning: false` keeps a feed out of journey planning while it still serves departures,
   * vehicles and alerts: the planner cannot search it within an isolate's memory. */
  feeds: readonly { id: string; realtime: readonly RealtimeFeedSpec[]; planning?: false }[];
  agencyTimezones: Readonly<Record<string, string>>;
  /** The region's clock. Its coordinators keep live data warm through local service hours
   * (SERVICE_HOURS) and poll on demand overnight; absent, they always poll on demand. */
  timezone?: string;
  supportedModes: readonly TransitMode[];
  bounds?: readonly [west: number, south: number, east: number, north: number];
  capabilities: CoverageCapability;
  thresholds: {
    tripUpdates: { realtimeSeconds: number; staleSeconds: number };
    vehiclePositions: { realtimeSeconds: number; unavailableSeconds: number };
    alerts: { currentSeconds: number };
    /** Elevator/escalator reports: current through `currentSeconds`, withdrawn after `expiredSeconds`. */
    equipment?: { currentSeconds: number; expiredSeconds: number };
    minimumScheduleMatchRate: number;
    maximumUnverifiedWalkMetres: number;
  };
  attribution: readonly TransitAttribution[];
}

const coverages: readonly CoverageManifest[] = [SFBAY_COVERAGE, DC_COVERAGE, NYC_COVERAGE];

/** Feeds a journey may use. */
export function planningFeedIds(coverage: CoverageManifest): string[] {
  return coverage.feeds.filter(feed => feed.planning !== false).map(feed => feed.id);
}

export function getCoverages(): readonly CoverageManifest[] { return coverages; }

/** Registry lookup does not enable a coverage or change legacy discovery. */
export function getCoverage(id: string): CoverageManifest | undefined {
  const normalized = id.trim().toLowerCase();
  return coverages.find(coverage => coverage.id === normalized ||
    coverage.displayName.toLowerCase() === normalized ||
    coverage.aliases.some(alias => alias.toLowerCase() === normalized));
}
