import { classifyFreshness, classifyManifestFreshness, observationAge, type FeedFreshness } from './freshness';
import type { RealtimeFeedKind } from '../../../regions/types';
import type { CoverageManifest } from '../../core/coverage';
import type { StaticVersion } from './snapshot-store';
import type { NormalizedVehicle } from './decode';

export interface FeedSnapshot<T> {
  producerTimestampSeconds?: number;
  receivedAtSeconds: number;
  payload: T;
  warnings?: string[];
  version?: StaticVersion;
  degraded?: boolean;
}

export interface FeedRead<T> {
  freshness: FeedFreshness;
  producerTimestampSeconds?: number;
  receivedAtSeconds?: number;
  payload: T | null;
  warnings: string[];
  status?: 'realtime' | 'scheduled_only' | 'unavailable';
  ageSeconds?: number | null;
  version?: StaticVersion;
  degraded?: boolean;
}

type Intervals = Partial<Record<RealtimeFeedKind, number>>;

/** Default equipment report freshness: a report older than an hour says nothing about now. */
const EQUIPMENT_THRESHOLDS = { currentSeconds: 900, expiredSeconds: 3600 };
/** Seconds a feed of `kind` stays fresh, and after which it is withdrawn. */
export function kindThresholds(policy: CoverageManifest['thresholds'], kind: RealtimeFeedKind): { fresh: number; expired: number } {
  if (kind === 'trip_updates') return { fresh: policy.tripUpdates.realtimeSeconds, expired: policy.tripUpdates.staleSeconds };
  if (kind === 'vehicle_positions') return { fresh: policy.vehiclePositions.realtimeSeconds, expired: policy.vehiclePositions.unavailableSeconds };
  if (kind === 'equipment_outages') { const equipment = policy.equipment ?? EQUIPMENT_THRESHOLDS; return { fresh: equipment.currentSeconds, expired: equipment.expiredSeconds }; }
  return { fresh: policy.alerts.currentSeconds, expired: Infinity };
}

export class RegionalFeedHubCore {
  readonly #policy: Intervals | CoverageManifest['thresholds'];
  readonly #snapshots = new Map<RealtimeFeedKind, FeedSnapshot<unknown>>();

  constructor(policy: Intervals | CoverageManifest['thresholds']) {
    this.#policy = policy;
  }

  replace<T>(kind: RealtimeFeedKind, snapshot: FeedSnapshot<T>): void {
    this.#snapshots.set(kind, snapshot);
  }

  read<T>(kind: RealtimeFeedKind, nowSeconds: number): FeedRead<T> {
    const snapshot = this.#snapshots.get(kind) as FeedSnapshot<T> | undefined;
    if ('tripUpdates' in this.#policy) {
      const policy = this.#policy;
      const { fresh: freshThrough, expired: staleThrough } = kindThresholds(policy, kind);
      const freshness = classifyManifestFreshness(snapshot?.producerTimestampSeconds, nowSeconds, freshThrough, staleThrough);
      const ageSeconds = observationAge(snapshot?.producerTimestampSeconds, nowSeconds);
      const available = snapshot && freshness !== 'expired' && freshness !== 'unavailable';
      // Reports (alerts, equipment) stay readable while stale, labelled by freshness.
      const status = (kind === 'service_alerts' || kind === 'equipment_outages') && available ? 'realtime' : freshness === 'fresh' && !snapshot?.degraded ? 'realtime' : kind === 'trip_updates' ? 'scheduled_only' : 'unavailable';
      let payload = snapshot && (available || kind === 'vehicle_positions') && !snapshot.degraded ? snapshot.payload : null;
      if (kind === 'vehicle_positions' && Array.isArray(payload)) {
        payload = payload.map((vehicle: NormalizedVehicle) => {
          const observationAgeSeconds = observationAge(vehicle.timestampSeconds, nowSeconds);
          return { ...vehicle, observationAgeSeconds, status: status === 'realtime' && observationAgeSeconds !== null && observationAgeSeconds <= freshThrough ? 'realtime' : 'unavailable' };
        }) as T;
      }
      return { freshness, status, ageSeconds, producerTimestampSeconds: snapshot?.producerTimestampSeconds,
        receivedAtSeconds: snapshot?.receivedAtSeconds, version: snapshot?.version, degraded: snapshot?.degraded,
        payload, warnings: [...(snapshot?.warnings ?? []), ...(freshness === 'stale' ? ['stale_feed'] : freshness === 'expired' ? ['expired_feed'] : freshness === 'unavailable' ? ['unavailable_feed'] : [])] };
    }
    const interval = this.#policy[kind];
    // A kind this policy does not configure has no freshness bound: never serve it.
    const freshness = interval === undefined ? 'unavailable' : classifyFreshness(snapshot?.producerTimestampSeconds, nowSeconds, interval);

    if (!snapshot || freshness === 'unavailable') {
      return { freshness: 'unavailable', payload: null, warnings: ['unavailable_feed'] };
    }
    if (freshness === 'expired') {
      return {
        freshness,
        producerTimestampSeconds: snapshot.producerTimestampSeconds,
        receivedAtSeconds: snapshot.receivedAtSeconds,
        payload: null,
        warnings: ['expired_feed'],
      };
    }

    return {
      freshness,
      producerTimestampSeconds: snapshot.producerTimestampSeconds,
      receivedAtSeconds: snapshot.receivedAtSeconds,
      payload: snapshot.payload,
      warnings: [...(snapshot.warnings ?? []), ...(freshness === 'stale' ? ['stale_feed'] : [])],
    };
  }
}
