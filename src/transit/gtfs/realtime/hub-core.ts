import { classifyFreshness, type FeedFreshness } from './freshness';
import type { RealtimeFeedKind } from '../../../regions/types';

export interface FeedSnapshot<T> {
  producerTimestampSeconds?: number;
  receivedAtSeconds: number;
  payload: T;
  warnings?: string[];
}

export interface FeedRead<T> {
  freshness: FeedFreshness;
  producerTimestampSeconds?: number;
  receivedAtSeconds?: number;
  payload: T | null;
  warnings: string[];
}

type Intervals = Record<RealtimeFeedKind, number>;

export class RegionalFeedHubCore {
  readonly #intervals: Intervals;
  readonly #snapshots = new Map<RealtimeFeedKind, FeedSnapshot<unknown>>();

  constructor(intervals: Intervals) {
    this.#intervals = intervals;
  }

  replace<T>(kind: RealtimeFeedKind, snapshot: FeedSnapshot<T>): void {
    this.#snapshots.set(kind, snapshot);
  }

  read<T>(kind: RealtimeFeedKind, nowSeconds: number): FeedRead<T> {
    const snapshot = this.#snapshots.get(kind) as FeedSnapshot<T> | undefined;
    const freshness = classifyFreshness(
      snapshot?.producerTimestampSeconds,
      nowSeconds,
      this.#intervals[kind],
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
