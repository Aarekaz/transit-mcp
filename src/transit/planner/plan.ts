import { parseTransitRef } from '../core/refs';
import { phase } from '../trace';
import type { VerificationReason } from '../core/results';
import { CLOCK_TOLERANCE_SECONDS, judgedAt, sameStaticVersion, staticVersion } from '../gtfs/realtime/snapshot-store';
import { loadScheduleWindow } from './schedule-index';
import { parseInstant } from './service-day';
import { assertNotAborted, routeDepartAt } from './raptor';
import { validateItinerary } from './validator';
import type { JourneyQuery, JourneyResult } from './types';

/** Heap held per shard byte once decoded. Three NYC rush-hour shards (6.6 MB) decode to
 * 14.5 MB, a ratio of 2.2; this keeps headroom over that. Labels, trip instances and
 * realtime rows are charged separately by the router. */
const DECODED_SHARD_FACTOR = 4;
/** A search along named lines keeps only their trips and stations; a whole shard is held
 * only while it is parsed. Metrobus bands keep about half their bytes for two routes
 * (unfiltered: 2.2x), so this keeps the same twofold headroom. */
const FILTERED_SHARD_FACTOR = 1;

export async function planJourney(query: JourneyQuery, signal?: AbortSignal): Promise<JourneyResult> {
  return phase('plan', () => planJourneyUntraced(query, signal));
}
async function planJourneyUntraced(query: JourneyQuery, signal?: AbortSignal): Promise<JourneyResult> {
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
  const factor = query.routeRefs ? FILTERED_SHARD_FACTOR : DECODED_SHARD_FACTOR;
  const window = await loadScheduleWindow({ manifest: query.manifest, instant: query.departAt, windowSeconds: query.windowSeconds ?? 7200, agencyRefs: query.agencyRefs, decoded: query.decoded, resident: query.resident, readConcurrency: query.readConcurrency, ...(query.routeRefs ? { decodeRoutes: query.routeRefs } : {}), ...(query.feedIds ? { feedIds: [...query.feedIds] } : {}),
    readShard: async key => {
      assertNotAborted(signal);
      const descriptor = query.manifest.shards.find(shard => shard.key === key)!;
      if ((bytes + descriptor.byteLength) * factor >= 48 * 1024 * 1024) throw new Error('Planner working-set budget exceeded; dedicated Durable Object required');
      const result = await query.readShard(key); assertNotAborted(signal); bytes += result.byteLength; return result;
    } });
  if (window.status === 'unavailable') return { status: 'unavailable', reasons: window.reasons, candidates: [], diagnostics: { rounds: 0, estimatedWorkingSetBytes: bytes * factor } };
  const snapshot = query.realtime;
  let realtime = snapshot?.payload ?? [];
  if (snapshot) {
    const stamp = snapshot.producerTimestampSeconds, observed = judgedAt(now, stamp);
    if (!sameStaticVersion(snapshot.version, version)) { reasons.add('SCHEDULE_REALTIME_MISMATCH'); realtime = []; }
    else if (snapshot.degraded || snapshot.payload === null || stamp === undefined || !Number.isFinite(stamp) || stamp <= 0 || stamp > observed ||
      !Number.isFinite(snapshot.receivedAtSeconds) || snapshot.receivedAtSeconds < stamp || snapshot.receivedAtSeconds > now + CLOCK_TOLERANCE_SECONDS) { reasons.add('REALTIME_UNAVAILABLE'); realtime = []; }
    else if (observed - stamp > (query.realtimeMaxAgeSeconds ?? 90)) { reasons.add('REALTIME_STALE'); realtime = []; }
  }
  const routed = await routeDepartAt(query, window.shards, version.artifactVersion, realtime, snapshot?.producerTimestampSeconds, bytes * factor, signal);
  routed.reasons.forEach(reason => reasons.add(reason));
  const candidates: JourneyResult['candidates'] = [];
  const source = { manifest: query.manifest, shards: window.shards.map(item => item.shard), now: query.now,
    realtime: query.realtime, realtimeMaxAgeSeconds: query.realtimeMaxAgeSeconds, ...(query.stepFree ? { stepFree: query.stepFree } : {}) };
  const rejected: unknown[] = [];
  for (const candidate of routed.candidates) {
    assertNotAborted(signal);
    const check = await validateItinerary(candidate, source, signal);
    if (!check.valid) {
      reasons.add('VALIDATOR_REJECTED');
      // Why: the validator's own reasons, so a planner/validator disagreement shows in logs.
      if (rejected.length < 3) rejected.push({ reasons: check.reasons, legFailures: check.legFailures, transferFailures: check.transferFailures,
        legs: candidate.legs.map(leg => leg.kind === 'transit' ? `${leg.routeRef.split(':').at(-1)}@${leg.boardSequence}-${leg.alightSequence}` : `walk${Math.round(leg.distanceMetres ?? 0)}`) });
      continue;
    }
    // Only independently proven journeys may dominate another candidate.
    if (!candidates.some(other => Date.parse(other.arrivalTime) <= Date.parse(candidate.arrivalTime) && other.transfers <= candidate.transfers && other.walkingMetres <= candidate.walkingMetres &&
      (other.transfers < candidate.transfers || other.walkingMetres < candidate.walkingMetres))) candidates.push(candidate);
    if (candidates.length === 3) break;
  }
  if (rejected.length) console.warn(JSON.stringify({ event: 'plan_validator_rejected', coverage: query.manifest.coverageId, kept: candidates.length, rejected }));
  return { status: candidates.length ? candidates.some(candidate => candidate.status === 'realtime') ? 'realtime' : 'scheduled_only' : 'unavailable',
    reasons: [...reasons], candidates, diagnostics: { rounds: routed.rounds, estimatedWorkingSetBytes: routed.estimatedWorkingSetBytes } };
}
