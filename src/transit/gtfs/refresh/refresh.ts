import type { Env } from '../../../types';
import { getCoverageMode } from '../../../regions/manifest';
import { canonicalJson, sha256 } from '../static/shards';
import { archiveText, bandText, bandTextRows, buildServiceDate, rangedStopTimes, scanArchive, startBands, type ArchiveText, type EdgeSource, type FeedIdentity, type ScanResult, type TripRanges, type TripStarts } from '../static/edge-build';
import { readZipDirectory, zipEntryStream } from '../static/zip';
import type { ArtifactManifestV2 } from '../static/schema';
import { StaticArtifactStore, readBoundedObject, staticVersion } from '../realtime/snapshot-store';
import { getRealtimeSource, getRealtimeSources, publishedKinds } from '../realtime/sources';
import { getStaticSource, getStaticSources, isPrimaryFeed, type StaticSourcePolicy } from './policy';
import { composeManifest } from '../static/compose';

/** Edge schedule refresh. A cheap cron check notices a changed source; a Workflow then
 * rebuilds only from that archive, one service date per step, checks the result against
 * the published version, publishes (pointer last), and rolls back if live matching drops. */
export const BAND_SECONDS = 3 * 3600;
/** `feedId` names a coverage's feed; omitted, the coverage's primary feed (runs started
 * before coverages held several feeds). */
export interface RefreshParams { coverageId: string; feedId?: string; archiveSha256: string; retrievedAt: string }
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
/** Per published version, each feed's stats. A version from before coverages held several
 * feeds stored its one feed's stats bare. */
type VersionStats = PublishedStats | { feeds: Record<string, PublishedStats> };
interface MatchStats { artifactVersion: string; eligible: number; matched: number; rate: number; atSeconds: number }

const encode = (value: unknown) => new TextEncoder().encode(`${canonicalJson(value)}\n`);
/** A coverage's primary feed keeps the keys it had before coverages held several feeds;
 * every other feed is scoped below it. Stats are one object per published version. */
export const sourceKeys = (coverageId: string, feedId?: string) => {
  const scope = feedId === undefined || isPrimaryFeed(coverageId, feedId) ? coverageId : `${coverageId}/${feedId}`;
  return {
    state: `sources/${scope}/state.json`,
    archive: (sha: string) => `sources/${scope}/${sha}.zip`,
    stats: (version: string) => `artifacts/${coverageId}/v2/stats/${version}.json`,
    /** Scratch for one run: the uncompressed stop_times and each trip's byte ranges. */
    work: (sha: string) => ({ prefix: `work/${scope}/${sha}/`, stopTimes: `work/${scope}/${sha}/stop_times.txt`, ranges: `work/${scope}/${sha}/trip-ranges.json`,
      text: `work/${scope}/${sha}/tables.json`, band: (band: number) => `work/${scope}/${sha}/bands/${band}.txt` }),
  };
};
function feedStats(stats: VersionStats | null, coverageId: string, feedId: string): PublishedStats | null {
  if (!stats) return null;
  return 'feeds' in stats ? stats.feeds[feedId] ?? null : isPrimaryFeed(coverageId, feedId) ? stats : null;
}
function allFeedStats(stats: VersionStats | null, coverageId: string): Record<string, PublishedStats> {
  if (!stats) return {};
  if ('feeds' in stats) return { ...stats.feeds };
  const primary = getStaticSource(coverageId)?.feedId;
  return primary ? { [primary]: stats } : {};
}
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

async function coordinatorStats(env: Env, coverageId: string, feedId: string): Promise<MatchStats | null> {
  // The coordinator that matches this feed's trips (a borough's, not the Bus Time relay).
  const realtime = getRealtimeSources(coverageId).find(source => source.policy.feedId === feedId && publishedKinds(source).has('trip_updates')) ?? getRealtimeSource(coverageId, feedId);
  if (!realtime || !env.REGION_FEED_HUB) return null;
  const response = await env.REGION_FEED_HUB.get(env.REGION_FEED_HUB.idFromName(realtime.policy.namespace)).fetch(`https://region-feed-hub.internal/stats?feed=${encodeURIComponent(feedId)}`);
  return response.ok ? await response.json<MatchStats | null>() : null;
}

export async function runRefresh(env: Env, params: RefreshParams, step: StepRunner): Promise<RefreshOutcome> {
  const policy = getStaticSource(params.coverageId, params.feedId);
  const bucket = env.TRANSIT_ARTIFACTS;
  if (!policy || !bucket) throw new Error('Refresh is not configured for this coverage');
  const keys = sourceKeys(policy.coverageId, policy.feedId), source = edgeSource(policy, params.retrievedAt);
  const bandSeconds = policy.bandSeconds ?? BAND_SECONDS;
  const archive = async () => {
    const bytes = await readBoundedObject(bucket, keys.archive(params.archiveSha256), policy.maxArchiveBytes);
    if (await sha256(bytes) !== params.archiveSha256) throw new Error('Source archive integrity failure');
    return bytes;
  };
  const work = keys.work(params.archiveSha256);
  const scan = await step.do('scan', async (): Promise<Omit<ScanResult, 'discoveryBytes' | 'stopTimes'> & { bands: number[] }> => {
    const bytes = await archive();
    const { discoveryBytes, stopTimes, ...result } = await scanArchive(bytes, source, policy.windowDays, Date.now());
    await putAbsent(bucket, result.discovery.key, discoveryBytes);
    // Day steps read only their trips' byte ranges from an uncompressed copy, instead of
    // inflating and parsing the whole table once per day.
    const entry = readZipDirectory(bytes).get('stop_times.txt')!, inflated = zipEntryStream(bytes, entry);
    await bucket.put(work.stopTimes, typeof FixedLengthStream === 'function' ? inflated.pipeThrough(new FixedLengthStream(entry.size)) : new Uint8Array(await new Response(inflated).arrayBuffer()));
    await bucket.put(work.ranges, JSON.stringify({ header: stopTimes.header, size: stopTimes.size, tripRanges: stopTimes.tripRanges, tripStarts: stopTimes.tripStarts }));
    if (policy.splitByBand) await bucket.put(work.text, JSON.stringify(await archiveText(bytes, source)));
    return { ...result, bands: policy.splitByBand ? startBands(stopTimes.tripStarts, bandSeconds) : [] };
  });
  type StoredIndex = { header: string; size: number; tripRanges: TripRanges; tripStarts: TripStarts };
  const index = async () => {
    const value = await readJson<StoredIndex>(bucket, work.ranges);
    if (!value) throw new Error('Missing stop_times range index');
    return value;
  };
  // Dense feeds: one step per band streams the stored copy once and keeps that band's rows.
  for (const band of scan.bands) {
    await step.do(`band:${band}`, async () => {
      const { header, tripStarts } = await index(), copy = await bucket.get(work.stopTimes);
      if (!copy) throw new Error('Missing stop_times work copy');
      await bucket.put(work.band(band), await bandText(copy.body, header, tripStarts, bandSeconds, band));
      return band;
    });
    // A fresh invocation for the next step: CPU never accumulates across them.
    await step.sleep(`yield:band:${band}`, 1000);
  }
  const dates: DateSummary[] = [];
  for (const date of scan.dates) {
    dates.push(await step.do(`date:${date}`, async () => {
      const stored = await index();
      let built;
      if (policy.splitByBand) {
        // Neither the archive nor the whole table: the stored small tables and band objects.
        const text = await readJson<ArchiveText>(bucket, work.text);
        if (!text) throw new Error('Missing stored tables');
        const bandRows = async function* (band: number) {
          const object = await bucket.get(work.band(band));
          if (!object) throw new Error('Missing stop_times band object');
          yield* bandTextRows(await object.text(), stored.header);
        };
        built = await buildServiceDate(null, source, scan.identity as FeedIdentity, date, bandSeconds,
          { header: stored.header, rows: () => { throw new Error('Split feeds read band objects'); }, starts: stored.tripStarts, bandRows, text });
      } else {
        const read = async (offset: number, length: number) => {
          const object = await bucket.get(work.stopTimes, { range: { offset, length } });
          if (!object) throw new Error('Missing stop_times work copy');
          return new Uint8Array(await object.arrayBuffer());
        };
        built = await buildServiceDate(await archive(), source, scan.identity as FeedIdentity, date, bandSeconds,
          { header: stored.header, rows: trips => rangedStopTimes(read, stored.header, stored.tripRanges, trips) });
      }
      for (const object of built.objects) await putAbsent(bucket, object.key, object.bytes);
      return { date, descriptors: built.descriptors, trips: built.trips };
    }));
    if (policy.splitByBand) await step.sleep(`yield:date:${date}`, 1000);
  }
  // This feed alone; it replaces only its own part of the coverage's manifest.
  const feedManifest: ArtifactManifestV2 = { schemaVersion: 2, coverageId: policy.coverageId, sources: scan.sources, agencyTimezones: scan.agencyTimezones,
    discoveries: [scan.discovery], shards: dates.flatMap(date => date.descriptors) };
  const stats: PublishedStats = { ...scan.stats, dates: Object.fromEntries(dates.map(date => [date.date, date.trips])) };
  const store = new StaticArtifactStore(bucket, policy.coverageId);
  const compose = async () => composeManifest((await store.current())?.manifest ?? null, feedManifest);

  const decision = await step.do('guard', async () => {
    const state = await readJson<SourceState>(bucket, keys.state);
    // A newer archive arrived while this one was building; its own run publishes.
    if (state?.sha256 && state.sha256 !== params.archiveSha256) return { publish: false, outcome: 'superseded' as const, reasons: [] as string[] };
    const pointer = await store.pointer();
    const previous = feedStats(pointer ? await readJson<VersionStats>(bucket, keys.stats(pointer.current)) : null, policy.coverageId, policy.feedId);
    const reasons = guardRefresh(previous, stats);
    if (pointer?.current === (await staticVersion(await compose())).artifactVersion) return { publish: false, outcome: 'unchanged' as const, reasons };
    return { publish: reasons.length === 0, outcome: reasons.length ? 'rejected' as const : 'published' as const, reasons,
      baseline: await coordinatorStats(env, policy.coverageId, policy.feedId) };
  });
  const cleanup = () => step.do('cleanup', async () => {
    await deletePrefix(bucket, work.prefix);
    return collectGarbage(bucket, policy.coverageId, params.archiveSha256, Date.now(), policy.feedId);
  });
  if (!decision.publish) {
    console.warn(JSON.stringify({ event: 'schedule_refresh', coverage: policy.coverageId, feed: policy.feedId, outcome: decision.outcome, reasons: decision.reasons, archive: params.archiveSha256 }));
    await cleanup();
    return { outcome: decision.outcome, reasons: decision.reasons };
  }
  const published = await step.do('publish', async () => {
    // Compose again from the version current now: another feed may have published since.
    const pointer = await store.pointer();
    const others = allFeedStats(pointer ? await readJson<VersionStats>(bucket, keys.stats(pointer.current)) : null, policy.coverageId);
    const manifest = await compose();
    const version = await store.publish(manifest);
    await bucket.put(keys.stats(version.artifactVersion), encode({ feeds: { ...others, [policy.feedId]: stats } } satisfies VersionStats));
    console.info(JSON.stringify({ event: 'schedule_refresh', coverage: policy.coverageId, feed: policy.feedId, outcome: 'published', artifactVersion: version.artifactVersion,
      archive: params.archiveSha256, dates: scan.dates.length, shards: manifest.shards.length, trips: stats.trips }));
    return version.artifactVersion;
  });

  // Canary: the coordinator re-matches live trips against the new version on its next
  // polls. A clear regression against the version it replaced is rolled back.
  const realtime = getRealtimeSource(policy.coverageId, policy.feedId);
  if (!realtime || getCoverageMode(policy.coverageId, env) === 'off') { await cleanup(); return { outcome: 'published', artifactVersion: published }; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await step.sleep(`settle:${attempt}`, 3 * 60_000);
    const verdict = await step.do(`canary:${attempt}`, async () => {
      const current = await coordinatorStats(env, policy.coverageId, policy.feedId);
      if (!current || current.artifactVersion !== published || current.eligible === 0) return 'pending' as const;
      const baseline = decision.baseline;
      const regressed = baseline ? current.rate < baseline.rate - 0.05 : current.rate < policy.coverage.thresholds.minimumScheduleMatchRate;
      if (!regressed) return 'healthy' as const;
      const rolledBack = await store.rollback(published);
      console.warn(JSON.stringify({ event: 'schedule_refresh', coverage: policy.coverageId, feed: policy.feedId, outcome: 'rolled_back', artifactVersion: published,
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
export async function collectGarbage(bucket: R2Bucket, coverageId: string, runArchive: string, now: number, runFeed?: string): Promise<{ deleted: number }> {
  const store = new StaticArtifactStore(bucket, coverageId), pointer = await store.pointer();
  if (!pointer) return { deleted: 0 };
  // Every feed of the coverage shares these prefixes; keep each one's archives and state.
  const feeds = getStaticSources().filter(policy => policy.coverageId === coverageId).map(policy => policy.feedId);
  const keep = new Set<string>(), archives = new Map<string, Set<string>>(feeds.map(feed => [feed, new Set<string>()]));
  const archive = (feed: string, sha: string) => { if (sha) (archives.get(feed) ?? archives.set(feed, new Set()).get(feed)!).add(sha); };
  if (runFeed ?? feeds[0]) archive(runFeed ?? feeds[0]!, runArchive);
  for (const version of [pointer.current, pointer.previous].filter((value): value is string => !!value)) {
    const { manifest } = await store.read(version);
    for (const object of [...manifest.shards, ...manifest.discoveries]) keep.add(object.key);
    keep.add(`artifacts/${coverageId}/v2/manifests/${version}.json`); keep.add(sourceKeys(coverageId).stats(version));
    for (const source of manifest.sources) archive(source.feedId, source.derivedFrom?.archiveSha256 ?? source.archiveSha256 ?? '');
  }
  for (const feed of feeds) {
    const keys = sourceKeys(coverageId, feed), state = await readJson<SourceState>(bucket, keys.state);
    if (state?.sha256) archive(feed, state.sha256);
    keep.add(keys.state);
  }
  for (const [feed, shas] of archives) for (const sha of shas) keep.add(sourceKeys(coverageId, feed).archive(sha));
  keep.add(`artifacts/${coverageId}/v2/current.json`);
  const runWork = sourceKeys(coverageId, runFeed).work(runArchive).prefix;
  const old = (object: R2Object) => now - object.uploaded.getTime() >= GARBAGE_MIN_AGE_MS;
  const candidates = [...await listAll(bucket, `artifacts/${coverageId}/v2/`), ...await listAll(bucket, `sources/${coverageId}/`), ...await listAll(bucket, `work/${coverageId}/`)];
  const garbage = candidates.filter(object => old(object) && !keep.has(object.key) && !object.key.startsWith(runWork)).map(object => object.key);
  await deleteKeys(bucket, garbage);
  return { deleted: garbage.length };
}

/** Whole days from one service date (YYYYMMDD) to another; negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  const at = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/** Claims one request from the coordinator that owns this coverage's credential budget. */
async function claimStaticQuota(env: Env, coverageId: string, feedId: string): Promise<boolean> {
  const realtime = getRealtimeSource(coverageId, feedId);
  if (!realtime || !env.REGION_FEED_HUB) return false;
  const response = await env.REGION_FEED_HUB.get(env.REGION_FEED_HUB.idFromName(realtime.policy.namespace))
    .fetch('https://region-feed-hub.internal/quota/static', { method: 'POST' });
  return response.ok && (await response.json<{ allowed: boolean }>()).allowed === true;
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** Streams a large archive into a staging object while hashing it, then moves it to its
 * content address only when it is new. Memory stays flat whatever the archive's size. */
async function storeStreamedArchive(bucket: R2Bucket, policy: StaticSourcePolicy, body: ReadableStream<Uint8Array>, declared: number, previous?: string): Promise<string> {
  const keys = sourceKeys(policy.coverageId, policy.feedId), staging = keys.archive('incoming');
  let total = 0;
  const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    total += chunk.byteLength;
    if (total > policy.maxArchiveBytes) throw new Error('source_too_large');
    controller.enqueue(chunk);
  } }));
  let hash: string;
  if (typeof crypto.DigestStream === 'function' && Number.isFinite(declared) && declared > 0) {
    const [toHash, toStore] = counted.tee(), digest = new crypto.DigestStream('SHA-256');
    await Promise.all([toHash.pipeTo(digest), bucket.put(staging, toStore.pipeThrough(new FixedLengthStream(declared)))]);
    hash = hex(await digest.digest);
  } else {
    // No streaming digest or declared length (tests, chunked replies): buffer once.
    const bytes = new Uint8Array(await new Response(counted).arrayBuffer());
    hash = await sha256(bytes);
    await bucket.put(staging, bytes);
  }
  if (hash !== previous && !await bucket.head(keys.archive(hash))) {
    const object = await bucket.get(staging);
    if (!object) throw new Error('source_staging_missing');
    await bucket.put(keys.archive(hash), typeof FixedLengthStream === 'function' ? object.body.pipeThrough(new FixedLengthStream(object.size)) : await object.arrayBuffer());
  }
  await bucket.delete(staging);
  return hash;
}

/** Cron: cheap change detection. A conditional GET usually answers 304 with no body;
 * only a new archive hash starts a refresh. Never throws for one coverage's failure. */
export async function checkStaticSources(env: Env, now: number): Promise<void> {
  const bucket = env.TRANSIT_ARTIFACTS, workflow = env.TRANSIT_REFRESH;
  if (!bucket || !workflow) return;
  await Promise.allSettled(getStaticSources().filter(policy => ['dark', 'on'].includes(getCoverageMode(policy.coverageId, env))).map(async policy => {
    const keys = sourceKeys(policy.coverageId, policy.feedId), primary = isPrimaryFeed(policy.coverageId, policy.feedId);
    try {
      const state = await readJson<SourceState>(bucket, keys.state) ?? { checkedAt: 0 };
      if (now - state.checkedAt < policy.checkIntervalSeconds * 1000 - 30_000) return;
      const headers: Record<string, string> = {}, target = new URL(policy.url);
      if (policy.auth.kind !== 'none') {
        const key = env[policy.auth.secretEnv];
        if (!key) throw new Error('source_credential_missing');
        if (policy.auth.kind === 'header') headers[policy.auth.header] = key; else target.searchParams.set(policy.auth.param, key);
      }
      if (policy.conditional && state.etag) headers['if-none-match'] = state.etag;
      if (policy.quota && !await claimStaticQuota(env, policy.coverageId, policy.feedId)) throw new Error('source_quota_exhausted');
      const response = await fetch(target, { headers, signal: AbortSignal.timeout(policy.stream ? 120_000 : 25_000) });
      let next: SourceState = { ...state, checkedAt: now };
      if (response.status !== 304) {
        if (!response.ok) throw new Error(`source_status_${response.status}`);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > policy.maxArchiveBytes) throw new Error('source_too_large');
        let hash: string;
        if (policy.stream && response.body) hash = await storeStreamedArchive(bucket, policy, response.body, declared, state.sha256);
        else {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > policy.maxArchiveBytes) throw new Error('source_too_large');
          hash = await sha256(bytes);
          if (hash !== state.sha256) await putAbsent(bucket, keys.archive(hash), bytes);
        }
        next = { sha256: hash, etag: response.headers.get('etag') ?? undefined, checkedAt: now,
          retrievedAt: hash === state.sha256 ? state.retrievedAt : new Date(now).toISOString(),
          ...(hash === state.sha256 && state.restarts ? { restarts: state.restarts } : {}) };
      }
      await bucket.put(keys.state, encode(next));
      // Start (or keep) a refresh until the published version came from this archive.
      const published = await new StaticArtifactStore(bucket, policy.coverageId).current().catch(() => null);
      const publishedSource = published?.manifest.sources.find(source => source.feedId === policy.feedId);
      const publishedArchive = publishedSource?.derivedFrom?.archiveSha256 ?? publishedSource?.archiveSha256;
      // A timetable covers a fixed window of days from when it was built. An archive the
      // publisher leaves unchanged must still be rebuilt before that window runs out.
      const today = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
      const windowEnd = published?.manifest.shards.filter(shard => shard.feedId === policy.feedId).reduce((end, shard) => shard.window.endDate > end ? shard.window.endDate : end, '');
      const rewindow = publishedArchive === next.sha256 && !!windowEnd && daysBetween(today, windowEnd) < Math.ceil(policy.windowDays / 2);
      if (policy.build !== 'offline' && next.sha256 && next.retrievedAt && (publishedArchive !== next.sha256 || rewindow)) {
        // Instance IDs from before coverages held several feeds stay valid for the primary feed;
        // a rebuild of the same archive is one instance per day.
        const id = `refresh-${policy.coverageId}-${primary ? '' : `${policy.feedId}-`}${next.sha256.slice(0, 32)}${rewindow ? `-w${today}` : ''}`;
        try {
          await workflow.create({ id, params: { coverageId: policy.coverageId, feedId: policy.feedId, archiveSha256: next.sha256, retrievedAt: next.retrievedAt } satisfies RefreshParams });
          console.info(JSON.stringify({ event: 'schedule_refresh_started', coverage: policy.coverageId, feed: policy.feedId, id }));
        } catch (error) {
          if (!(error instanceof Error && /already exists|exists/i.test(error.message))) throw error;
          // One instance per archive. A run that failed (not one that is running, waiting or
          // decided not to publish) is restarted a bounded number of times.
          const instance = await workflow.get(id), { status } = await instance.status();
          if ((status === 'errored' || status === 'terminated') && (next.restarts ?? 0) < MAX_REFRESH_RESTARTS) {
            await instance.restart();
            next = { ...next, restarts: (next.restarts ?? 0) + 1 };
            await bucket.put(keys.state, encode(next));
            console.warn(JSON.stringify({ event: 'schedule_refresh_restarted', coverage: policy.coverageId, feed: policy.feedId, id, restarts: next.restarts }));
          } else if (status === 'errored' || status === 'terminated') {
            console.warn(JSON.stringify({ event: 'schedule_refresh_gave_up', coverage: policy.coverageId, feed: policy.feedId, id }));
          }
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'schedule_source_check_failed', coverage: policy.coverageId, feed: policy.feedId,
        reason: error instanceof Error && /^source_[a-z0-9_]+$/.test(error.message) ? error.message : 'source_request_failed' }));
    }
  }));
}
