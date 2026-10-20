import type { Env } from '../../types';
import { getCoverages, networkPlanning } from '../core/coverage';
import { getCoverageMode } from '../../regions/manifest';
import { StaticArtifactStore, readBoundedObject } from '../gtfs/realtime/snapshot-store';
import type { DiscoveryIndex } from '../gtfs/static/schema';
import { decodeDiscoveryIndex, decodeScheduleShard, sha256 } from '../gtfs/static/shards';
import { buildCompactBand } from './compact';
import { compactKey, compactPrefix } from './network-plan';
import { serviceDateAtInstant, shiftServiceDate } from './service-day';

/** Bands built per coverage per tick. A band takes about 40 ms of CPU to decode and pack
 * (measured on SF, NYC and DC); a coverage-day is 35 to 280 bands. */
const BANDS_PER_TICK = 120;
/** Compact bands of a shard no longer referenced survive this long, as artifacts do. */
const UNREFERENCED_MIN_AGE_MS = 2 * 3600_000;

/** Builds the compact bands the network planner reads for yesterday, today and tomorrow,
 * a bounded number per cron tick, and removes bands no current or previous artifact
 * references. A band not built yet only means plan_trip plans as before. */
export async function compactSchedules(env: Env, now: number): Promise<void> {
  const bucket = env.TRANSIT_ARTIFACTS;
  if (!bucket) return;
  // One coverage at a time: each holds its discovery indexes and one decoded shard.
  for (const coverage of getCoverages().filter(item => networkPlanning(item.id, env) && ['dark', 'on'].includes(getCoverageMode(item.id, env)))) {
    try { await compactCoverage(bucket, coverage.id, now); }
    catch (error) { console.warn(JSON.stringify({ event: 'compact_failed', coverage: coverage.id, error: error instanceof Error ? error.message : 'unknown' })); }
  }
}

export async function compactCoverage(bucket: R2Bucket, coverageId: string, now: number, limit = BANDS_PER_TICK): Promise<{ built: number; missing: number; deleted: number }> {
  const store = new StaticArtifactStore(bucket, coverageId), pointer = await store.pointer();
  if (!pointer) return { built: 0, missing: 0, deleted: 0 };
  const { manifest } = await store.read(pointer.current);
  const timezone = Object.values(manifest.agencyTimezones)[0] ?? 'UTC', today = serviceDateAtInstant(now, timezone);
  const dates = new Set([shiftServiceDate(today, -1), today, shiftServiceDate(today, 1)]);
  const discoveries = new Map(manifest.discoveries.map(descriptor => [descriptor.feedId, descriptor]));
  const existing = new Map<string, R2Object>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: compactPrefix(coverageId), ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) existing.set(object.key, object);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const wanted = manifest.shards.filter(shard => shard.window.startDate === shard.window.endDate && dates.has(shard.window.startDate) && discoveries.has(shard.feedId))
    .map(shard => ({ shard, key: compactKey(coverageId, shard.sha256, discoveries.get(shard.feedId)!.sha256) }))
    .filter(item => !existing.has(item.key))
    // Today first: a request needs the bands around now before tomorrow's.
    .sort((a, b) => Math.abs(Number(a.shard.window.startDate) - Number(today)) - Math.abs(Number(b.shard.window.startDate) - Number(today)) || a.key.localeCompare(b.key));
  const decoded = new Map<string, DiscoveryIndex>();
  let built = 0;
  for (const { shard, key } of wanted.slice(0, limit)) {
    const descriptor = discoveries.get(shard.feedId)!;
    let discovery = decoded.get(shard.feedId);
    if (!discovery) {
      const bytes = await readBoundedObject(bucket, descriptor.key, 64 * 1024 * 1024);
      if (bytes.length !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Discovery integrity');
      discovery = decodeDiscoveryIndex(bytes); decoded.set(shard.feedId, discovery);
    }
    const bytes = await readBoundedObject(bucket, shard.key, 64 * 1024 * 1024);
    if (bytes.length !== shard.byteLength || await sha256(bytes) !== shard.sha256) throw new Error('Schedule shard integrity failure');
    await bucket.put(key, buildCompactBand(decodeScheduleShard(bytes), discovery, shard.sha256, descriptor.sha256));
    built++;
  }
  // Only once everything wanted exists: remove bands of shards neither version references.
  let deleted = 0;
  if (wanted.length <= limit) {
    const keep = new Set<string>();
    for (const version of [pointer.current, pointer.previous].filter((value): value is string => !!value)) {
      const { manifest: referenced } = version === pointer.current ? { manifest } : await store.read(version);
      const shas = new Map(referenced.discoveries.map(item => [item.feedId, item.sha256]));
      for (const shard of referenced.shards) if (shas.has(shard.feedId)) keep.add(compactKey(coverageId, shard.sha256, shas.get(shard.feedId)!));
    }
    const garbage = [...existing.values()].filter(object => !keep.has(object.key) && now - object.uploaded.getTime() >= UNREFERENCED_MIN_AGE_MS).map(object => object.key);
    for (let at = 0; at < garbage.length; at += 1000) await bucket.delete(garbage.slice(at, at + 1000));
    deleted = garbage.length;
  }
  console.info(JSON.stringify({ event: 'compact', coverage: coverageId, built, missing: Math.max(0, wanted.length - built), deleted }));
  return { built, missing: Math.max(0, wanted.length - built), deleted };
}
