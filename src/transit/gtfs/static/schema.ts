import type { CoverageManifest } from '../../core/coverage';
import type { TransitRef } from '../../core/refs';
import type { ServiceCalendar } from './artifact';
import type { TransitMode } from './modes';

export type GtfsScheduleFiles = Record<'agency.txt' | 'stops.txt' | 'routes.txt' | 'trips.txt' | 'stop_times.txt', string>
  & Partial<Record<'calendar.txt' | 'calendar_dates.txt' | 'feed_info.txt' | 'frequencies.txt' | 'transfers.txt' | 'pathways.txt', string>>;
export interface ServiceWindow { startDate: string; endDate: string }
/** Seconds from the service-day origin. A banded shard holds only trips whose
 * first departure is in [bandStart, bandEnd); start/end bound every call it holds. */
export interface ShardTimeRange { bandStart: number; bandEnd: number; start: number; end: number }
export interface SourceMetadata {
  feedId: string;
  /** Public credential-free endpoint, never the authenticated download URL. */
  url: string;
  retrievedAt: string;
  /** Hash of canonical parsed GTFS tables, independent of CSV ordering. */
  sha256: string;
  /** Hash of the exact archive bytes the validator report describes. */
  archiveSha256?: string;
  /** Present when the validated archive was derived from the publisher's archive. */
  derivedFrom?: { archiveSha256: string; excludedFiles: string[]; reason: string;
    /** Publisher fields the build did not use (`file:field`), with the same reason. */
    ignoredFields?: string[] };
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
  /** Absent for whole-day shards; present when a service day is split into time bands. */
  timeRange?: ShardTimeRange;
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
  /** Sorted unique IDs from all trips.txt rows, including trips outside the loaded window. */
  tripProviderIds: string[];
  stops: ScheduleStop[]; routes: ScheduleRoute[]; stopRoutes: Record<TransitRef, TransitRef[]>;
  /** Distinct stations the publisher links with a stop-level transfer (one station complex
   * published as several stations), as sorted [a, b] pairs. Absent in older artifacts. */
  stationLinks?: [TransitRef, TransitRef][];
}
export interface ArtifactObject { key: string; sha256: string; byteLength: number }
export interface ValidatorEvidence {
  name: 'MobilityData GTFS Validator'; version: string; reportSha256: string; validatedAt: string;
  systemErrorsSha256: string; systemErrorsFormat: 'MobilityData notices';
  /** ERROR codes accepted because they concern only inputs this build does not read. */
  acceptedErrors?: string[];
}
export interface ArtifactManifestV2 {
  schemaVersion: 2; coverageId: string; sources: SourceMetadata[];
  agencyTimezones: Record<TransitRef, string>;
  discoveries: (ArtifactObject & { feedId: string })[];
  shards: (ArtifactObject & { feedId: string; window: ServiceWindow; maxStopTimeSeconds: number; timeRange?: ShardTimeRange;
    /** Present when a band is split by agency: the only agencies whose trips it holds. */
    agencyRefs?: TransitRef[] })[];
  validator?: ValidatorEvidence;
}
export interface CompileScheduleInput {
  coverage: CoverageManifest; feedId: string; files: GtfsScheduleFiles;
  window: ServiceWindow; source: Pick<SourceMetadata, 'url' | 'retrievedAt'>;
  /** Set when one archive is compiled in parts (per service date): every part carries the
   * whole feed's identity and feed-wide timetable bound instead of its own. */
  identity?: { sha256: string; maxStopTimeSeconds: number } & Pick<SourceMetadata, 'archiveSha256' | 'derivedFrom'>;
  /** Publisher fields left unused. `trips.txt:block_id` drops in-seat block continuations:
   * riders transfer at the same stop instead. Recorded in the source's derivation. */
  ignoredFields?: readonly IgnorableField[];
}
export type IgnorableField = 'trips.txt:block_id';
export interface CompiledSchedule {
  manifest: ArtifactManifestV2; discovery: DiscoveryIndex; shard: ScheduleShard;
  discoveryBytes: Uint8Array; shardBytes: Uint8Array;
}
