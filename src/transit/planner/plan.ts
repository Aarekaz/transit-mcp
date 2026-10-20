import { parseTransitRef } from '../core/refs';
import type { VerificationReason } from '../core/results';
import { sameStaticVersion, staticVersion } from '../gtfs/realtime/snapshot-store';
import { loadScheduleWindow } from './schedule-index';
import { parseInstant } from './service-day';
import { assertNotAborted, routeDepartAt } from './raptor';
import { validateItinerary } from './validator';
import type { JourneyQuery, JourneyResult } from './types';

/** Heap held per shard byte once decoded. Three NYC rush-hour shards (6.6 MB) decode to
 * 14.5 MB, a ratio of 2.2; this keeps headroom over that. Labels, trip instances and
 * realtime rows are charged separately by the router. */
const DECODED_SHARD_FACTOR = 4;

export async function planJourney(query: JourneyQuery, signal?: AbortSignal): Promise<JourneyResult> {
  assertNotAborted(signal);
  parseInstant(query.departAt);
  const now = parseInstant(query.now) / 1000;
  for (const endpoint of [query.origin, query.destination]) {
    if (typeof endpoint === 'string') {
      const ref = parseTransitRef(endpoint);
      if (!ref || ref.kind !== 'stop' || ref.coverage !== query.manifest.coverageId || endpoint.split(':').length !== 5) throw new Error('INVALID_TRANSIT_REF: journey endpoints must be stops in this coverage');
    } else if (!Number.isFinite(endpoint.latitude) || Math.abs(endpoint.latitude) > 90 || !Number.isFinite(endpoint.longitude) || Math.abs(endpoint.longitude) > 180) throw new Error('Invalid endpoint coordinates');
  }
  if (!Number.isInteger(query.maxTransfers ?? 3) || (query.maxTransfers ?? 3) < 0 || (query.maxTransfers ?? 3) > 4 ||
    !Number.isFinite(query.maxWalkMetres ?? 800) || (query.maxWalkMetres ?? 800) < 0 ||
    !Number.isFinite(query.realtimeMaxAgeSeconds ?? 90) || (query.realtimeMaxAgeSeconds ?? 90) < 0) throw new Error('Invalid journey limits');
  const reasons = new Set<VerificationReason>();
  const version = await staticVersion(query.manifest); assertNotAborted(signal);
  let bytes = 0;
  const window = await loadScheduleWindow({ manifest: query.manifest, instant: query.departAt, windowSeconds: query.windowSeconds ?? 7200, decoded: query.decoded, ...(query.feedIds ? { feedIds: [...query.feedIds] } : {}),
    readShard: async key => {
      assertNotAborted(signal);
      const descriptor = query.manifest.shards.find(shard => shard.key === key)!;
      if ((bytes + descriptor.byteLength) * DECODED_SHARD_FACTOR >= 48 * 1024 * 1024) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
      const result = await query.readShard(key); assertNotAborted(signal); bytes += result.byteLength; return result;
    } });
  if (window.status === 'unavailable') return { status: 'unavailable', reasons: window.reasons, candidates: [], diagnostics: { rounds: 0, estimatedWorkingSetBytes: bytes * DECODED_SHARD_FACTOR } };
  const snapshot = query.realtime;
  let realtime = snapshot?.payload ?? [];
  if (snapshot) {
    const stamp = snapshot.producerTimestampSeconds;
    if (!sameStaticVersion(snapshot.version, version)) { reasons.add('SCHEDULE_REALTIME_MISMATCH'); realtime = []; }
    else if (snapshot.degraded || snapshot.payload === null || stamp === undefined || !Number.isFinite(stamp) || stamp <= 0 || stamp > now ||
      !Number.isFinite(snapshot.receivedAtSeconds) || snapshot.receivedAtSeconds < stamp || snapshot.receivedAtSeconds > now) { reasons.add('REALTIME_UNAVAILABLE'); realtime = []; }
    else if (now - stamp > (query.realtimeMaxAgeSeconds ?? 90)) { reasons.add('REALTIME_STALE'); realtime = []; }
  }
  const routed = await routeDepartAt(query, window.shards, version.artifactVersion, realtime, snapshot?.producerTimestampSeconds, bytes * DECODED_SHARD_FACTOR, signal);
  routed.reasons.forEach(reason => reasons.add(reason));
  const candidates: JourneyResult['candidates'] = [];
  const source = { manifest: query.manifest, shards: window.shards.map(item => item.shard), now: query.now,
    realtime: query.realtime, realtimeMaxAgeSeconds: query.realtimeMaxAgeSeconds, ...(query.stepFree ? { stepFree: query.stepFree } : {}) };
  for (const candidate of routed.candidates) {
    assertNotAborted(signal);
    if (!(await validateItinerary(candidate, source, signal)).valid) { reasons.add('VALIDATOR_REJECTED'); continue; }
    // Only independently proven journeys may dominate another candidate.
    if (!candidates.some(other => Date.parse(other.arrivalTime) <= Date.parse(candidate.arrivalTime) && other.transfers <= candidate.transfers && other.walkingMetres <= candidate.walkingMetres &&
      (other.transfers < candidate.transfers || other.walkingMetres < candidate.walkingMetres))) candidates.push(candidate);
    if (candidates.length === 3) break;
  }
  return { status: candidates.length ? candidates.some(candidate => candidate.status === 'realtime') ? 'realtime' : 'scheduled_only' : 'unavailable',
    reasons: [...reasons], candidates, diagnostics: { rounds: routed.rounds, estimatedWorkingSetBytes: routed.estimatedWorkingSetBytes } };
}
