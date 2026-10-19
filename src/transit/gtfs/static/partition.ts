import { isServiceActive } from '../../planner/service-day';
import { parseServiceDate } from './time';
import { encodeScheduleShard, sha256 } from './shards';
import type { ArtifactManifestV2, CompiledSchedule, ScheduleShard, ShardTimeRange } from './schema';

export interface PartitionedSchedule {
  manifest: ArtifactManifestV2;
  objects: { key: string; bytes: Uint8Array }[];
  shards: ScheduleShard[];
}

function dates(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  const end = parseServiceDate(endDate).getTime();
  for (let date = parseServiceDate(startDate); date.getTime() <= end; date = new Date(date.getTime() + 86_400_000)) {
    result.push(date.toISOString().slice(0, 10).replaceAll('-', ''));
  }
  return result;
}

/** Splits one compiled window into per-service-date, first-departure time bands so a
 * query decodes only the timetable it can use. Offline only. Inputs whose meaning
 * crosses trips (blocks, trip transfers, headway templates) are refused rather than
 * cut, because a band boundary would silently drop a continuation or a template. */
export async function partitionSchedule(compiled: CompiledSchedule, bandSeconds: number): Promise<PartitionedSchedule> {
  const { shard } = compiled;
  if (!Number.isInteger(bandSeconds) || bandSeconds < 3600 || bandSeconds > 86_400) throw new Error('Invalid time band (1-24 hours)');
  if (shard.frequencies.length) throw new Error('Time bands do not support frequency-based trips');
  if (Object.keys(shard.blocks).length) throw new Error('Time bands do not support block continuations');
  if (shard.transferBoundaryTrips.length || shard.transfers.some(transfer => transfer.fromTripRef || transfer.toTripRef)) {
    throw new Error('Time bands do not support trip-specific transfers');
  }
  const bandCount = Math.floor(shard.maxStopTimeSeconds / bandSeconds) + 1;
  const prefix = `artifacts/${shard.coverageId}/v2/${shard.feedId}`;
  const objects: PartitionedSchedule['objects'] = [];
  const shards: ScheduleShard[] = [];
  const descriptors: ArtifactManifestV2['shards'] = [];
  for (const date of dates(shard.window.startDate, shard.window.endDate)) {
    // GTFS: a trip visiting fewer than two stops is unusable by passengers (validator
    // notice unusable_trip). Never publish one as service.
    const active = shard.trips.filter(trip => isServiceActive(shard.calendars[trip.serviceId]!, date) &&
      trip.stopTimes.filter(call => call.departureSeconds !== null).length >= 2);
    for (let band = 0; band < bandCount; band++) {
      const bandStart = band * bandSeconds, bandEnd = bandStart + bandSeconds;
      const trips = active.filter(trip => {
        const first = trip.stopTimes[0]!.departureSeconds;
        return first !== null && first >= bandStart && first < bandEnd;
      });
      // An empty date still needs one object so the date reads as "no service",
      // never as an expired schedule.
      if (!trips.length && (band > 0 || active.length)) continue;
      const calls = trips.flatMap(trip => trip.stopTimes.flatMap(call => [call.arrivalSeconds, call.departureSeconds]))
        .filter((value): value is number => value !== null);
      const firsts = trips.map(trip => trip.stopTimes[0]!.departureSeconds!);
      const timeRange: ShardTimeRange = { bandStart, bandEnd,
        start: firsts.length ? Math.min(...firsts) : bandStart, end: calls.length ? Math.max(...calls) : bandStart };
      const patternIds = new Set(trips.map(trip => trip.patternId)), serviceIds = new Set(trips.map(trip => trip.serviceId));
      const part: ScheduleShard = { ...shard, window: { startDate: date, endDate: date }, timeRange, trips,
        patterns: shard.patterns.filter(pattern => patternIds.has(pattern.id)),
        calendars: Object.fromEntries(Object.entries(shard.calendars).filter(([id]) => serviceIds.has(id))) };
      const bytes = encodeScheduleShard(part), hash = await sha256(bytes);
      const key = `${prefix}/${date}/${String(bandStart).padStart(6, '0')}/${hash}.bin`;
      objects.push({ key, bytes });
      shards.push(part);
      descriptors.push({ feedId: shard.feedId, window: part.window, maxStopTimeSeconds: shard.maxStopTimeSeconds, timeRange, key, sha256: hash, byteLength: bytes.length });
    }
  }
  objects.push({ key: compiled.manifest.discoveries[0]!.key, bytes: compiled.discoveryBytes });
  return { manifest: { ...compiled.manifest, shards: descriptors }, objects, shards };
}
