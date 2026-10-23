import type { DecodedShardCache } from './schedule-index';
import type { TransitRef, TripInstanceRef } from '../core/refs';
import type { VerificationReason, VerificationStatus } from '../core/results';
import type { NormalizedStopUpdate } from '../gtfs/realtime/decode';
import type { NormalizedRealtimeSnapshot } from '../gtfs/realtime/snapshot-store';
import type { ArtifactManifestV2, ScheduleShard } from '../gtfs/static/schema';

export type JourneyEndpoint = TransitRef | { latitude: number; longitude: number };
export interface TransitLeg {
  kind: 'transit'; from: TransitRef; to: TransitRef;
  tripRef: TransitRef; tripInstanceRef: TripInstanceRef; serviceDate: string; instanceStartSeconds: number;
  routeRef: TransitRef; directionId: number | null; headsign: string;
  boardSequence: number; alightSequence: number; scheduleVersion: string;
  scheduledDepartureTime: string; scheduledArrivalTime: string;
  departureTime: string; arrivalTime: string; status: 'realtime' | 'scheduled_only';
  realtimeTimestampSeconds?: number; continuation: boolean;
}
export interface WalkLeg {
  kind: 'walk'; from: JourneyEndpoint; to: JourneyEndpoint;
  departureTime: string; arrivalTime: string; distanceMetres: number;
  verification: 'pathway' | 'unverified'; estimated: boolean; pathwayId?: string;
}
export type ItineraryLeg = TransitLeg | WalkLeg;
export interface Itinerary {
  coverageId: string; artifactVersion: string; origin: JourneyEndpoint; destination: JourneyEndpoint;
  departAt: string; windowSeconds: number; maxWalkMetres: number; maxTransfers: number;
  departureTime: string; arrivalTime: string; walkingMetres: number; transfers: number;
  status: 'realtime' | 'scheduled_only'; legs: ItineraryLeg[];
}
export interface ValidationSource {
  manifest: ArtifactManifestV2;
  /** Canonical decoded immutable shards, never planner labels or traversal indexes. */
  shards: ScheduleShard[];
  realtime?: NormalizedRealtimeSnapshot<NormalizedStopUpdate>;
  /** Explicit observation time, independent of future requested departure. */
  now: string;
  realtimeMaxAgeSeconds?: number;
  /** Rechecks judge a journey on current predictions. */
  recheck?: boolean;
  /** The newest feed in a combined snapshot: a leg's observation may be as new as its own feed. */
  realtimeNewestSeconds?: number;
  realtimeReasons?: VerificationReason[];
  /** Step-free journeys board and alight only at these stops (accessible now, no
   * unrecovered elevator outage) and never ride a trip marked not wheelchair accessible. */
  stepFree?: { usableStopRefs: ReadonlySet<TransitRef> };
}
export interface JourneyQuery extends Omit<ValidationSource, 'shards'> {
  readShard: (key: string) => Promise<Uint8Array>;
  /** Receives each decoded shard, so a caller can read trips without decoding again. */
  decoded?: DecodedShardCache;
  /** Whole decodes kept across requests (the isolate's), consulted after `decoded`. */
  resident?: DecodedShardCache;
  origin: JourneyEndpoint; destination: JourneyEndpoint; departAt: string;
  /** Other stations an endpoint stands for, when one name is a place several make up (Penn
   * Station: two subway stations and the LIRR's). The network search starts or ends at any of
   * them, and each journey names the one it uses. */
  originStops?: readonly TransitRef[]; destinationStops?: readonly TransitRef[];
  /** Exact journeys must arrive inside this horizon (default two hours, max seven days). */
  windowSeconds?: number;
  /** Total walking budget, capped at 800 metres; straight-line estimates are explicitly unverified. */
  maxWalkMetres?: number;
  /** Vehicle changes, default three, maximum four. In-seat continuation does not consume one. */
  maxTransfers?: number;
  /** For agency-split schedules: the agencies whose service this search may use. */
  agencyRefs?: TransitRef[];
  /** Feeds the search may use; all of the manifest's when omitted. */
  feedIds?: readonly string[];
  /** Only trips on these routes, e.g. the lines a model proposes. The search still finds
   * the trips, boarding stops, transfers and walks; every result is validated as usual. */
  routeRefs?: ReadonlySet<TransitRef>;
  /** Shards read at once (see ScheduleWindowQuery.readConcurrency); default one. */
  readConcurrency?: number;
}
export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  legFailures: { index: number; reasons: string[] }[];
  transferFailures: { fromLegIndex: number; toLegIndex: number; reasons: string[] }[];
}
export interface JourneyResult {
  status: VerificationStatus; reasons: VerificationReason[]; candidates: Itinerary[];
  diagnostics: { rounds: number; estimatedWorkingSetBytes: number };
}
