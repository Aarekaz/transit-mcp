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

type Intervals = Record<RealtimeFeedKind, number>;

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
      const freshThrough = kind === 'trip_updates' ? policy.tripUpdates.realtimeSeconds : kind === 'vehicle_positions' ? policy.vehiclePositions.realtimeSeconds : policy.alerts.currentSeconds;
      const staleThrough = kind === 'trip_updates' ? policy.tripUpdates.staleSeconds : kind === 'vehicle_positions' ? policy.vehiclePositions.unavailableSeconds : Infinity;
      const freshness = classifyManifestFreshness(snapshot?.producerTimestampSeconds, nowSeconds, freshThrough, staleThrough);
      const ageSeconds = observationAge(snapshot?.producerTimestampSeconds, nowSeconds);
      const available = snapshot && freshness !== 'expired' && freshness !== 'unavailable';
      const status = kind === 'service_alerts' && available ? 'realtime' : freshness === 'fresh' && !snapshot?.degraded ? 'realtime' : kind === 'trip_updates' ? 'scheduled_only' : 'unavailable';
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
    const freshness = classifyFreshness(
      snapshot?.producerTimestampSeconds,
      nowSeconds,
      this.#policy[kind],
    );

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
