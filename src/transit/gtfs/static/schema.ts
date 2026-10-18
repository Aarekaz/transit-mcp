import type { CoverageManifest } from '../../core/coverage';
import type { TransitRef } from '../../core/refs';
import type { ServiceCalendar } from './artifact';
import type { TransitMode } from './modes';

export type GtfsScheduleFiles = Record<'agency.txt' | 'stops.txt' | 'routes.txt' | 'trips.txt' | 'stop_times.txt', string>
  & Partial<Record<'calendar.txt' | 'calendar_dates.txt' | 'feed_info.txt' | 'frequencies.txt' | 'transfers.txt' | 'pathways.txt', string>>;
export interface ServiceWindow { startDate: string; endDate: string }
export interface SourceMetadata {
  feedId: string;
  /** Public credential-free endpoint, never the authenticated download URL. */
  url: string;
  retrievedAt: string;
  /** Hash of canonical parsed GTFS tables, independent of CSV ordering. */
  sha256: string;
  feedInfo: Record<string, string>[];
  /** Deterministic normalization only when the single source agency omits its ID. */
  anonymousAgencyRef?: TransitRef;
}
export interface ScheduleStop {
  ref: TransitRef; providerId: string; name: string;
  latitude: number | null; longitude: number | null; locationType: number;
  parentStationRef?: TransitRef; wheelchairBoarding: number;
}
export interface ScheduleRoute {
  ref: TransitRef; providerId: string; agencyRef: TransitRef;
  shortName: string; longName: string; mode: TransitMode; routeType: number;
  color: string; textColor: string;
}
export interface TripStopTime {
  stopRef: TransitRef; sequence: number;
  /** Untimed intermediate rows remain in the pattern; never invent an arrival. */
  arrivalSeconds: number | null; departureSeconds: number | null;
  pickupType: number; dropOffType: number; timepoint: number; headsign: string;
}
export interface ScheduleTrip {
  ref: TransitRef; providerId: string; routeRef: TransitRef; serviceId: string;
  patternId: string; headsign: string; directionId: number | null; blockId: string;
  wheelchairAccessible: number; bikesAllowed: number; stopTimes: TripStopTime[];
}
export interface SchedulePattern {
  id: string; routeRef: TransitRef; directionId: number | null;
  stopRefs: TransitRef[]; pickupTypes: number[]; dropOffTypes: number[];
}
export interface ScheduleTransfer {
  fromStopRef?: TransitRef; toStopRef?: TransitRef;
  fromRouteRef?: TransitRef; toRouteRef?: TransitRef;
  fromTripRef?: TransitRef; toTripRef?: TransitRef;
  transferType: number; minTransferSeconds: number | null;
}
export interface SchedulePathway {
  id: string; fromStopRef: TransitRef; toStopRef: TransitRef;
  mode: number; bidirectional: boolean; lengthMetres: number | null;
  traversalSeconds: number | null; stairCount: number | null;
  maxSlope: number | null; minWidthMetres: number | null;
  signpostedAs: string; reversedSignpostedAs: string;
}
export interface ScheduleShard {
  schemaVersion: 2; coverageId: string; feedId: string; window: ServiceWindow;
  /** Feed-wide upper bound, including frequency-expanded calls and trips outside this window. */
  maxStopTimeSeconds: number;
  source: SourceMetadata; agencyTimezones: Record<TransitRef, string>;
  stops: ScheduleStop[]; routes: ScheduleRoute[]; trips: ScheduleTrip[];
  patterns: SchedulePattern[]; calendars: Record<string, ServiceCalendar>;
  frequencies: { tripRef: TransitRef; startSeconds: number; endSeconds: number; headwaySeconds: number; exactTimes: number }[];
  blocks: Record<string, TransitRef[]>;
  transfers: ScheduleTransfer[]; pathways: SchedulePathway[];
  /** Transfer endpoints absent from this window. Resolve their service dates via
   * calendars, then load the same feed/source.sha256 window containing that date.
   * Times remain relative to the endpoint's own service day, including >24h. */
  transferBoundaryTrips: (Pick<ScheduleTrip, 'ref' | 'providerId' | 'routeRef' | 'serviceId'> & {
    firstDepartureSeconds: number | null; lastArrivalSeconds: number | null;
  })[];
}
export interface DiscoveryIndex {
  schemaVersion: 2; coverageId: string; feedId: string;
  sourceSha256: string;
  stops: ScheduleStop[]; routes: ScheduleRoute[]; stopRoutes: Record<TransitRef, TransitRef[]>;
}
export interface ArtifactObject { key: string; sha256: string; byteLength: number }
export interface ValidatorEvidence {
  name: 'MobilityData GTFS Validator'; version: string; reportSha256: string; validatedAt: string;
  systemErrorsSha256: string; systemErrorsFormat: 'MobilityData notices';
}
export interface ArtifactManifestV2 {
  schemaVersion: 2; coverageId: string; sources: SourceMetadata[];
  agencyTimezones: Record<TransitRef, string>;
  discovery: ArtifactObject;
  shards: (ArtifactObject & { feedId: string; window: ServiceWindow; maxStopTimeSeconds: number })[];
  validator?: ValidatorEvidence;
}
export interface CompileScheduleInput {
  coverage: CoverageManifest; feedId: string; files: GtfsScheduleFiles;
  window: ServiceWindow; source: Pick<SourceMetadata, 'url' | 'retrievedAt'>;
}
export interface CompiledSchedule {
  manifest: ArtifactManifestV2; discovery: DiscoveryIndex; shard: ScheduleShard;
  discoveryBytes: Uint8Array; shardBytes: Uint8Array;
}
