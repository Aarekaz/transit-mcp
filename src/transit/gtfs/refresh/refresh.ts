import type { Env } from '../../../types';
import { getCoverageMode } from '../../../regions/manifest';
import { canonicalJson, sha256 } from '../static/shards';
import { buildServiceDate, rangedStopTimes, scanArchive, type EdgeSource, type FeedIdentity, type ScanResult, type TripRanges } from '../static/edge-build';
import { readZipDirectory, zipEntryStream } from '../static/zip';
import type { ArtifactManifestV2 } from '../static/schema';
import { StaticArtifactStore, readBoundedObject, staticVersion } from '../realtime/snapshot-store';
import { getRealtimeSource } from '../realtime/sources';
import { getStaticSource, getStaticSources, type StaticSourcePolicy } from './policy';

/** Edge schedule refresh. A cheap cron check notices a changed source; a Workflow then
 * rebuilds only from that archive, one service date per step, checks the result against
 * the published version, publishes (pointer last), and rolls back if live matching drops. */
export const BAND_SECONDS = 3 * 3600;
export interface RefreshParams { coverageId: string; archiveSha256: string; retrievedAt: string }
export interface SourceState { sha256?: string; etag?: string; checkedAt: number; retrievedAt?: string; restarts?: number }
/** A failed run for the current archive is retried this many times, then left for a human. */
export const MAX_REFRESH_RESTARTS = 3;
export interface StepRunner {
  do<T>(name: string, run: () => Promise<T>): Promise<T>;
  sleep(name: string, milliseconds: number): Promise<void>;
}
export type RefreshOutcome = { outcome: 'published' | 'unchanged' | 'superseded' | 'rejected' | 'rolled_back'; reasons?: string[]; artifactVersion?: string };
interface DateSummary { date: string; descriptors: ArtifactManifestV2['shards']; trips: number }
interface PublishedStats { stops: number; routes: number; trips: number; dates: Record<string, number> }
interface MatchStats { artifactVersion: string; eligible: number; matched: number; rate: number; atSeconds: number }

const encode = (value: unknown) => new TextEncoder().encode(`${canonicalJson(value)}\n`);
export const sourceKeys = (coverageId: string) => ({
  state: `sources/${coverageId}/state.json`,
  archive: (sha: string) => `sources/${coverageId}/${sha}.zip`,
  stats: (version: string) => `artifacts/${coverageId}/v2/stats/${version}.json`,
  /** Scratch for one run: the uncompressed stop_times and each trip's byte ranges. */
  work: (sha: string) => ({ prefix: `work/${coverageId}/${sha}/`, stopTimes: `work/${coverageId}/${sha}/stop_times.txt`, ranges: `work/${coverageId}/${sha}/trip-ranges.json` }),
});
/** Objects younger than this are never collected: a concurrent run may not have published yet. */
export const GARBAGE_MIN_AGE_MS = 2 * 3600_000;

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? await object.json<T>() : null;
}

/** Content-addressed objects are immutable: an existing key already holds these bytes. */
async function putAbsent(bucket: R2Bucket, key: string, bytes: Uint8Array): Promise<boolean> {
  if (await bucket.head(key)) return false;
  await bucket.put(key, bytes);
  return true;
}

function edgeSource(policy: StaticSourcePolicy & { coverage: EdgeSource['coverage'] }, retrievedAt: string): EdgeSource {
  return { coverage: policy.coverage, feedId: policy.feedId, url: policy.url, retrievedAt, exclude: policy.exclude };
}

/** Bounded change between consecutive published versions. A legitimate publisher update
 * does not remove most stops or a date's service; a broken or truncated one does. */
export function guardRefresh(previous: PublishedStats | null, next: PublishedStats): string[] {
  const reasons: string[] = [];
  if (next.trips === 0 || next.stops === 0 || next.routes === 0) reasons.push('EMPTY_SCHEDULE');
  if (!previous) return reasons;
  if (next.stops < previous.stops * 0.95) reasons.push(`STOPS_DROPPED:${previous.stops}->${next.stops}`);
  if (next.routes < previous.routes * 0.9) reasons.push(`ROUTES_DROPPED:${previous.routes}->${next.routes}`);
  for (const [date, trips] of Object.entries(next.dates)) {
    const before = previous.dates[date];
    if (before !== undefined && before > 0 && trips < before * 0.7) reasons.push(`SERVICE_DROPPED:${date}:${before}->${trips}`);
  }
  return reasons;
}

async function coordinatorStats(env: Env, coverageId: string): Promise<MatchStats | null> {
  const realtime = getRealtimeSource(coverageId);
  if (!realtime || !env.REGION_FEED_HUB) return null;
  const response = await env.REGION_FEED_HUB.get(env.REGION_FEED_HUB.idFromName(realtime.policy.namespace)).fetch('https://region-feed-hub.internal/stats');
  return response.ok ? await response.json<MatchStats | null>() : null;
}

export async function runRefresh(env: Env, params: RefreshParams, step: StepRunner): Promise<RefreshOutcome> {
  const policy = getStaticSource(params.coverageId);
  const bucket = env.TRANSIT_ARTIFACTS;
  if (!policy || !bucket) throw new Error('Refresh is not configured for this coverage');
  const keys = sourceKeys(policy.coverageId), source = edgeSource(policy, params.retrievedAt);
  const archive = async () => {
    const bytes = await readBoundedObject(bucket, keys.archive(params.archiveSha256), policy.maxArchiveBytes);
    if (await sha256(bytes) !== params.archiveSha256) throw new Error('Source archive integrity failure');
    return bytes;
  };
  const work = keys.work(params.archiveSha256);
  const scan = await step.do('scan', async (): Promise<Omit<ScanResult, 'discoveryBytes' | 'stopTimes'>> => {
    const bytes = await archive();
    const { discoveryBytes, stopTimes, ...result } = await scanArchive(bytes, source, policy.windowDays, Date.now());
    await putAbsent(bucket, result.discovery.key, discoveryBytes);
    // Day steps read only their trips' byte ranges from an uncompressed copy, instead of
    // inflating and parsing the whole table once per day.
    const entry = readZipDirectory(bytes).get('stop_times.txt')!, inflated = zipEntryStream(bytes, entry);
    await bucket.put(work.stopTimes, typeof FixedLengthStream === 'function' ? inflated.pipeThrough(new FixedLengthStream(entry.size)) : new Uint8Array(await new Response(inflated).arrayBuffer()));
    await bucket.put(work.ranges, JSON.stringify({ header: stopTimes.header, size: stopTimes.size, tripRanges: stopTimes.tripRanges }));
    return result;
  });
  const dates: DateSummary[] = [];
  for (const date of scan.dates) {
    dates.push(await step.do(`date:${date}`, async () => {
      const index = await readJson<{ header: string; size: number; tripRanges: TripRanges }>(bucket, work.ranges);
      if (!index) throw new Error('Missing stop_times range index');
      const read = async (offset: number, length: number) => {
        const object = await bucket.get(work.stopTimes, { range: { offset, length } });
        if (!object) throw new Error('Missing stop_times work copy');
        return new Uint8Array(await object.arrayBuffer());
      };
      const built = await buildServiceDate(await archive(), source, scan.identity as FeedIdentity, date, BAND_SECONDS,
        { header: index.header, rows: trips => rangedStopTimes(read, index.header, index.tripRanges, trips) });
      for (const object of built.objects) await putAbsent(bucket, object.key, object.bytes);
      return { date, descriptors: built.descriptors, trips: built.trips };
    }));
  }
  const manifest: ArtifactManifestV2 = { schemaVersion: 2, coverageId: policy.coverageId, sources: scan.sources, agencyTimezones: scan.agencyTimezones,
    discoveries: [scan.discovery], shards: dates.flatMap(date => date.descriptors) };
  const stats: PublishedStats = { ...scan.stats, dates: Object.fromEntries(dates.map(date => [date.date, date.trips])) };
  const store = new StaticArtifactStore(bucket, policy.coverageId);

  const decision = await step.do('guard', async () => {
    const state = await readJson<SourceState>(bucket, keys.state);
    // A newer archive arrived while this one was building; its own run publishes.
    if (state?.sha256 && state.sha256 !== params.archiveSha256) return { publish: false, outcome: 'superseded' as const, reasons: [] as string[] };
    const pointer = await store.pointer();
    const previous = pointer ? await readJson<PublishedStats>(bucket, keys.stats(pointer.current)) : null;
    const reasons = guardRefresh(previous, stats);
    if (pointer?.current === (await staticVersion(manifest)).artifactVersion) return { publish: false, outcome: 'unchanged' as const, reasons };
    return { publish: reasons.length === 0, outcome: reasons.length ? 'rejected' as const : 'published' as const, reasons,
      baseline: await coordinatorStats(env, policy.coverageId) };
  });
  const cleanup = () => step.do('cleanup', async () => {
    await deletePrefix(bucket, work.prefix);
    return collectGarbage(bucket, policy.coverageId, params.archiveSha256, Date.now());
  });
  if (!decision.publish) {
    console.warn(JSON.stringify({ event: 'schedule_refresh', coverage: policy.coverageId, outcome: decision.outcome, reasons: decision.reasons, archive: params.archiveSha256 }));
    await cleanup();
    return { outcome: decision.outcome, reasons: decision.reasons };
  }
  const published = await step.do('publish', async () => {
    const version = await store.publish(manifest);
    await bucket.put(keys.stats(version.artifactVersion), encode(stats));
    console.info(JSON.stringify({ event: 'schedule_refresh', coverage: policy.coverageId, outcome: 'published', artifactVersion: version.artifactVersion,
      archive: params.archiveSha256, dates: scan.dates.length, shards: manifest.shards.length, trips: stats.trips }));
    return version.artifactVersion;
  });

  // Canary: the coordinator re-matches live trips against the new version on its next
  // polls. A clear regression against the version it replaced is rolled back.
  const realtime = getRealtimeSource(policy.coverageId);
  if (!realtime || getCoverageMode(policy.coverageId, env) === 'off') { await cleanup(); return { outcome: 'published', artifactVersion: published }; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await step.sleep(`settle:${attempt}`, 3 * 60_000);
    const verdict = await step.do(`canary:${attempt}`, async () => {
      const current = await coordinatorStats(env, policy.coverageId);
      if (!current || current.artifactVersion !== published || current.eligible === 0) return 'pending' as const;
      const baseline = decision.baseline;
      const regressed = baseline ? current.rate < baseline.rate - 0.05 : current.rate < policy.coverage.thresholds.minimumScheduleMatchRate;
      if (!regressed) return 'healthy' as const;
      const rolledBack = await store.rollback(published);
      console.warn(JSON.stringify({ event: 'schedule_refresh', coverage: policy.coverageId, outcome: 'rolled_back', artifactVersion: published,
        rate: current.rate, baseline: baseline?.rate ?? null, rolledBack }));
      return rolledBack ? 'rolled_back' as const : 'healthy' as const;
    });
    if (verdict === 'rolled_back') { await cleanup(); return { outcome: 'rolled_back', artifactVersion: published }; }
    if (verdict === 'healthy') break;
  }
  await cleanup();
  return { outcome: 'published', artifactVersion: published };
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  await deleteKeys(bucket, (await listAll(bucket, prefix)).map(object => object.key));
}

/** Keeps every object the current and previous versions reference (rollback target), the
 * archives they and this run came from, and anything younger than GARBAGE_MIN_AGE_MS. */
export async function collectGarbage(bucket: R2Bucket, coverageId: string, runArchive: string, now: number): Promise<{ deleted: number }> {
  const store = new StaticArtifactStore(bucket, coverageId), pointer = await store.pointer();
  if (!pointer) return { deleted: 0 };
  const keep = new Set<string>(), archives = new Set([runArchive]), keys = sourceKeys(coverageId);
  for (const version of [pointer.current, pointer.previous].filter((value): value is string => !!value)) {
    const { manifest } = await store.read(version);
    for (const object of [...manifest.shards, ...manifest.discoveries]) keep.add(object.key);
    keep.add(`artifacts/${coverageId}/v2/manifests/${version}.json`); keep.add(keys.stats(version));
    for (const source of manifest.sources) archives.add(source.derivedFrom?.archiveSha256 ?? source.archiveSha256 ?? '');
  }
  const state = await readJson<SourceState>(bucket, keys.state);
  if (state?.sha256) archives.add(state.sha256);
  for (const sha of archives) if (sha) keep.add(keys.archive(sha));
  keep.add(`artifacts/${coverageId}/v2/current.json`); keep.add(keys.state);
  const old = (object: R2Object) => now - object.uploaded.getTime() >= GARBAGE_MIN_AGE_MS;
  const candidates = [...await listAll(bucket, `artifacts/${coverageId}/v2/`), ...await listAll(bucket, `sources/${coverageId}/`), ...await listAll(bucket, `work/${coverageId}/`)];
  const garbage = candidates.filter(object => old(object) && !keep.has(object.key) && !object.key.startsWith(keys.work(runArchive).prefix)).map(object => object.key);
  await deleteKeys(bucket, garbage);
  return { deleted: garbage.length };
}

/** Cron: cheap change detection. A conditional GET usually answers 304 with no body;
 * only a new archive hash starts a refresh. Never throws for one coverage's failure. */
export async function checkStaticSources(env: Env, now: number): Promise<void> {
  const bucket = env.TRANSIT_ARTIFACTS, workflow = env.TRANSIT_REFRESH;
  if (!bucket || !workflow) return;
  await Promise.allSettled(getStaticSources().filter(policy => ['dark', 'on'].includes(getCoverageMode(policy.coverageId, env))).map(async policy => {
    const keys = sourceKeys(policy.coverageId);
    try {
      const state = await readJson<SourceState>(bucket, keys.state) ?? { checkedAt: 0 };
      if (now - state.checkedAt < policy.checkIntervalSeconds * 1000 - 30_000) return;
      const headers: Record<string, string> = {};
      if (policy.auth.kind === 'header') {
        const key = env[policy.auth.secretEnv];
        if (!key) throw new Error('source_credential_missing');
        headers[policy.auth.header] = key;
      }
      if (policy.conditional && state.etag) headers['if-none-match'] = state.etag;
      const response = await fetch(policy.url, { headers, signal: AbortSignal.timeout(25_000) });
      let next: SourceState = { ...state, checkedAt: now };
      if (response.status !== 304) {
        if (!response.ok) throw new Error(`source_status_${response.status}`);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > policy.maxArchiveBytes) throw new Error('source_too_large');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > policy.maxArchiveBytes) throw new Error('source_too_large');
        const hash = await sha256(bytes);
        if (hash !== state.sha256) await putAbsent(bucket, keys.archive(hash), bytes);
        next = { sha256: hash, etag: response.headers.get('etag') ?? undefined, checkedAt: now,
          retrievedAt: hash === state.sha256 ? state.retrievedAt : new Date(now).toISOString(),
          ...(hash === state.sha256 && state.restarts ? { restarts: state.restarts } : {}) };
      }
      await bucket.put(keys.state, encode(next));
      // Start (or keep) a refresh until the published version came from this archive.
      const published = await new StaticArtifactStore(bucket, policy.coverageId).current().catch(() => null);
      const publishedArchive = published?.manifest.sources[0]?.derivedFrom?.archiveSha256 ?? published?.manifest.sources[0]?.archiveSha256;
      if (next.sha256 && next.retrievedAt && publishedArchive !== next.sha256) {
        const id = `refresh-${policy.coverageId}-${next.sha256.slice(0, 32)}`;
        try {
          await workflow.create({ id, params: { coverageId: policy.coverageId, archiveSha256: next.sha256, retrievedAt: next.retrievedAt } satisfies RefreshParams });
          console.info(JSON.stringify({ event: 'schedule_refresh_started', coverage: policy.coverageId, id }));
        } catch (error) {
          if (!(error instanceof Error && /already exists|exists/i.test(error.message))) throw error;
          // One instance per archive. A run that failed (not one that is running, waiting or
          // decided not to publish) is restarted a bounded number of times.
          const instance = await workflow.get(id), { status } = await instance.status();
          if ((status === 'errored' || status === 'terminated') && (next.restarts ?? 0) < MAX_REFRESH_RESTARTS) {
            await instance.restart();
            next = { ...next, restarts: (next.restarts ?? 0) + 1 };
            await bucket.put(keys.state, encode(next));
            console.warn(JSON.stringify({ event: 'schedule_refresh_restarted', coverage: policy.coverageId, id, restarts: next.restarts }));
          } else if (status === 'errored' || status === 'terminated') {
            console.warn(JSON.stringify({ event: 'schedule_refresh_gave_up', coverage: policy.coverageId, id }));
          }
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'schedule_source_check_failed', coverage: policy.coverageId,
        reason: error instanceof Error && /^source_[a-z0-9_]+$/.test(error.message) ? error.message : 'source_request_failed' }));
    }
  }));
}
