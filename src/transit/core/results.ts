export type VerificationStatus = 'realtime' | 'scheduled_only' | 'unavailable';

export const VERIFICATION_REASONS = [
  'REALTIME_STALE',
  'REALTIME_UNAVAILABLE',
  'SCHEDULE_EXPIRED',
  'SCHEDULE_APPROXIMATE',
  'SCHEDULE_REALTIME_MISMATCH',
  'TRIP_CANCELED',
  'STOP_SKIPPED',
  'VALIDATOR_REJECTED',
  'COVERAGE_UNAVAILABLE',
  'SCOPE_LIMIT_EXCEEDED',
  // Step-free requests: no current equipment report, or an endpoint without step-free access now.
  'ACCESSIBILITY_UNAVAILABLE',
  'ENDPOINT_NOT_STEP_FREE',
  // The coverage serves departures, alerts and vehicles but does not plan journeys (SF Bay).
  'PLANNING_UNAVAILABLE',
] as const;

export type VerificationReason = typeof VERIFICATION_REASONS[number];

export function isVerificationReason(value: unknown): value is VerificationReason {
  return typeof value === 'string' && VERIFICATION_REASONS.some(reason => reason === value);
}

export interface TransitAttribution {
  text: string;
  url: string;
  license?: string;
}

export interface SourceStatus {
  feedId: string;
  kind: 'gtfs_schedule' | 'trip_updates' | 'vehicle_positions' | 'alerts' | 'equipment_outages' | 'native_api';
  producerTimestamp: string | null;
  ingestedAt: string;
  ageSeconds: number | null;
  scheduleVersion: string;
}

export interface TransitResultStatus {
  status: VerificationStatus;
  reasons: VerificationReason[];
  sources: SourceStatus[];
  attribution: TransitAttribution[];
}
