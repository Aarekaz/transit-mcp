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
  kind: 'gtfs_schedule' | 'trip_updates' | 'vehicle_positions' | 'alerts' | 'native_api';
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
