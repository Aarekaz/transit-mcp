import { SFBAY_REGION } from '../../../regions/sfbay';
import type { RealtimeFeedKind, RealtimeFeedSpec, RealtimeSourcePolicy } from '../../../regions/types';
import { getCoverage, type CoverageManifest } from '../../core/coverage';
import { getCoverageMode } from '../../../regions/manifest';
import type { Env } from '../../../types';
import { SF511_QUOTA_NAMESPACE } from './snapshot-store';

/** Server-side provider adapters. Public coverage manifests stay credential-free. */
const policies: Readonly<Record<string, RealtimeSourcePolicy>> = {
  sfbay: { namespace: SF511_QUOTA_NAMESPACE, feedId: 'sf511', auth: { kind: 'query_token', secretEnv: SFBAY_REGION.secretEnv },
    budget: SFBAY_REGION.realtime.budget, tripMatching: 'exact' },
  dc: { namespace: 'dc:wmata', feedId: 'wmata', auth: { kind: 'header', header: 'api_key', secretEnv: 'WMATA_API_KEY' },
    // Shares the legacy tools' key: stay far below WMATA's default daily allowance.
    budget: { requestsPerHour: 600, safetyFactor: 0.8, reserveForStatic: 0 }, tripMatching: 'exact' },
  nyc: { namespace: 'nyc:mta', feedId: 'mta_subway', auth: { kind: 'none' },
    budget: { requestsPerHour: 1500, safetyFactor: 1, reserveForStatic: 0 }, tripMatching: 'nyct_suffix', extensions: 'nyct', matchWindowSeconds: 4 * 3600,
    alertAgencyAliases: { MTASBWY: 'MTA NYCT' } },
};

export interface RealtimeSource { coverage: CoverageManifest; policy: RealtimeSourcePolicy; feeds: readonly RealtimeFeedSpec[] }

export function getRealtimeSource(coverageId: string): RealtimeSource | undefined {
  const coverage = getCoverage(coverageId), policy = coverage && policies[coverage.id];
  if (!coverage || !policy) return undefined;
  const feeds = coverage.feeds.find(feed => feed.id === policy.feedId)?.realtime ?? [];
  return feeds.length ? { coverage, policy, feeds } : undefined;
}

export function getRealtimeSources(): RealtimeSource[] {
  return Object.keys(policies).flatMap(id => getRealtimeSource(id) ?? []);
}

/** Ingestion runs while a coverage is dark (validation before launch) or on. */
export function ingestionActive(source: RealtimeSource, env: Env): boolean {
  const mode = getCoverageMode(source.coverage.id, env);
  return (mode === 'dark' || mode === 'on') && credential(source, env) !== null;
}

/** Undefined means no credential is required; null means a required one is absent. */
export function credential(source: RealtimeSource, env: Env): string | undefined | null {
  if (source.policy.auth.kind === 'none') return undefined;
  const value = env[source.policy.auth.secretEnv];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Every kind the coordinator publishes, including kinds read from another kind's documents. */
export function publishedKinds(source: RealtimeSource): ReadonlySet<RealtimeFeedKind> {
  return new Set(source.feeds.flatMap(feed => [feed.kind, ...feed.alsoPublishes ?? []]));
}

export function feedParts(spec: RealtimeFeedSpec): readonly { id: string; url: URL }[] {
  if (spec.parts?.length) return spec.parts;
  if (!spec.url) throw new Error('Realtime feed has no upstream');
  return [{ id: spec.kind, url: spec.url }];
}

export function upstreamRequest(source: RealtimeSource, url: URL, env: Env): Request {
  const headers: Record<string, string> = { accept: 'application/x-google-protobuf' };
  const target = new URL(url);
  const key = credential(source, env);
  if (key === null) throw new Error('upstream_credential_missing');
  if (key !== undefined && source.policy.auth.kind === 'query_token') target.searchParams.set('api_key', key);
  if (key !== undefined && source.policy.auth.kind === 'header') headers[source.policy.auth.header] = key;
  return new Request(target, { headers });
}
