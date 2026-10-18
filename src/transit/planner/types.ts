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
}
export interface JourneyQuery extends Omit<ValidationSource, 'shards'> {
  readShard: (key: string) => Promise<Uint8Array>;
  origin: JourneyEndpoint; destination: JourneyEndpoint; departAt: string;
  /** Exact journeys must arrive inside this horizon (default two hours, max seven days). */
  windowSeconds?: number;
  /** Total walking budget, capped at 800 metres; straight-line estimates are explicitly unverified. */
  maxWalkMetres?: number;
  /** Vehicle changes, default three, maximum four. In-seat continuation does not consume one. */
  maxTransfers?: number;
}
export interface ValidationResult { valid: boolean; reasons: string[] }
export interface JourneyResult {
  status: VerificationStatus; reasons: VerificationReason[]; candidates: Itinerary[];
  diagnostics: { rounds: number; estimatedWorkingSetBytes: number };
}
