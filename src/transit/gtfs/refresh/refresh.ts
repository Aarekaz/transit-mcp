import type { Env } from '../../../types';
import { getCoverageMode } from '../../../regions/manifest';
import { canonicalJson, sha256 } from '../static/shards';
import { buildServiceDate, scanArchive, type EdgeSource, type FeedIdentity, type ScanResult } from '../static/edge-build';
import type { ArtifactManifestV2 } from '../static/schema';
import { StaticArtifactStore, readBoundedObject, staticVersion } from '../realtime/snapshot-store';
import { getRealtimeSource } from '../realtime/sources';
import { getStaticSource, getStaticSources, type StaticSourcePolicy } from './policy';

/** Edge schedule refresh. A cheap cron check notices a changed source; a Workflow then
 * rebuilds only from that archive, one service date per step, checks the result against
 * the published version, publishes (pointer last), and rolls back if live matching drops. */
export const BAND_SECONDS = 3 * 3600;
export interface RefreshParams { coverageId: string; archiveSha256: string; retrievedAt: string }
export interface SourceState { sha256?: string; etag?: string; checkedAt: number; retrievedAt?: string }
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
});

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
  const scan = await step.do('scan', async (): Promise<Omit<ScanResult, 'discoveryBytes'>> => {
    const { discoveryBytes, ...result } = await scanArchive(await archive(), source, policy.windowDays, Date.now());
    await putAbsent(bucket, result.discovery.key, discoveryBytes);
    return result;
  });
  const dates: DateSummary[] = [];
  for (const date of scan.dates) {
    dates.push(await step.do(`date:${date}`, async () => {
      const built = await buildServiceDate(await archive(), source, scan.identity as FeedIdentity, date, BAND_SECONDS);
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
  if (!decision.publish) {
    console.warn(JSON.stringify({ event: 'schedule_refresh', coverage: policy.coverageId, outcome: decision.outcome, reasons: decision.reasons, archive: params.archiveSha256 }));
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
  if (!realtime || getCoverageMode(policy.coverageId, env) === 'off') return { outcome: 'published', artifactVersion: published };
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
    if (verdict === 'rolled_back') return { outcome: 'rolled_back', artifactVersion: published };
    if (verdict === 'healthy') break;
  }
  return { outcome: 'published', artifactVersion: published };
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
          retrievedAt: hash === state.sha256 ? state.retrievedAt : new Date(now).toISOString() };
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
          // An instance per archive: an existing one (running, done or failed) is not repeated.
          if (!(error instanceof Error && /already exists|exists/i.test(error.message))) throw error;
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'schedule_source_check_failed', coverage: policy.coverageId,
        reason: error instanceof Error && /^source_[a-z0-9_]+$/.test(error.message) ? error.message : 'source_request_failed' }));
    }
  }));
}
