import { SFBAY_REGION } from '../../../regions/sfbay';
import type { RealtimeFeedKind, RealtimeFeedSpec, RealtimeSourcePolicy } from '../../../regions/types';
import { getCoverage, type CoverageManifest } from '../../core/coverage';
import { getCoverageMode } from '../../../regions/manifest';
import type { Env } from '../../../types';
import { SF511_QUOTA_NAMESPACE } from './snapshot-store';
import { NYC_BUS_FEEDS } from '../../../regions/nyc';

const wmataKey = { kind: 'header', header: 'api_key', secretEnv: 'WMATA_API_KEY' } as const;
const busTimeKey = { kind: 'query_token', secretEnv: 'MTA_BUS_API_KEY', param: 'key' } as const;
const BUS_TIME_RELAY = 'realtime/nyc/relay/mta_bus';
/** Server-side provider adapters, one per static feed: each gets its own coordinator,
 * snapshots and request budget. A coverage's first feed is its primary one. Public
 * coverage manifests stay credential-free. */
const policies: Readonly<Record<string, readonly RealtimeSourcePolicy[]>> = {
  sfbay: [{ namespace: SF511_QUOTA_NAMESPACE, feedId: 'sf511', auth: { kind: 'query_token', secretEnv: SFBAY_REGION.secretEnv },
    // 511 omits start_date for BART, Caltrain, Marin, SolTrans and others, and keeps reporting
    // trips up to an hour past their scheduled end. Predictions reach about an hour ahead.
    budget: SFBAY_REGION.realtime.budget, tripMatching: 'exact', matchWindowSeconds: 90 * 60, matchLookbackSeconds: 3600, undatedTrips: 'current_service_day',
    // Observed in 511 RG on 2026-10-19 against its own timetable (see docs/sfbay-rollout.md).
    providerQuirks: { renumberedStopSequences: true, advisoryStartTimes: true, staleEntities: true } }],
  // Rail and bus share the legacy tools' key. Together they stay far below WMATA's default
  // allowance (50,000 requests a day): 480 + 320 an hour at most.
  dc: [{ namespace: 'dc:wmata', feedId: 'wmata', auth: wmataKey, budget: { requestsPerHour: 600, safetyFactor: 0.8, reserveForStatic: 0 }, tripMatching: 'exact' },
    { namespace: 'dc:wmata_bus', feedId: 'wmata_bus', auth: wmataKey, budget: { requestsPerHour: 400, safetyFactor: 0.8, reserveForStatic: 0 }, tripMatching: 'exact',
      // Bus trips are short; a three-hour timetable span covers every trip in service.
      matchWindowSeconds: 3 * 3600 }],
  nyc: [{ namespace: 'nyc:mta', feedId: 'mta_subway', auth: { kind: 'none' },
    budget: { requestsPerHour: 1500, safetyFactor: 1, reserveForStatic: 0 }, tripMatching: 'nyct_suffix', extensions: 'nyct', matchWindowSeconds: 4 * 3600,
    alertAgencyAliases: { MTASBWY: 'MTA NYCT' } },
  { namespace: 'nyc:lirr', feedId: 'lirr', auth: { kind: 'none' },
    budget: { requestsPerHour: 400, safetyFactor: 1, reserveForStatic: 0 }, tripMatching: 'exact', extensions: 'mta_railroad' },
  { namespace: 'nyc:mnr', feedId: 'mnr', auth: { kind: 'none' },
    budget: { requestsPerHour: 400, safetyFactor: 1, reserveForStatic: 0 }, tripMatching: 'train_number', extensions: 'mta_railroad',
    alertAgencyAliases: { MNR: '1' } },
  // MTA Bus Time: one realtime source for every NYC bus timetable. It never polls without
  // MTA_BUS_API_KEY, so NYC bus predictions, locations and alerts stay off until it is set.
  // One relay makes every Bus Time request (about two a minute) and publishes the alerts;
  // each borough timetable has its own coordinator reading the relayed documents, since one
  // isolate cannot hold the whole city's matching (81,000 calls an hour, six timetables).
  { namespace: 'nyc:mta_bus', feedId: NYC_BUS_FEEDS[0]!, alsoFeedIds: NYC_BUS_FEEDS.slice(1), auth: busTimeKey,
    budget: { requestsPerHour: 400, safetyFactor: 1, reserveForStatic: 0 }, tripMatching: 'exact', matchWindowSeconds: 3600,
    kinds: ['trip_updates', 'vehicle_positions', 'service_alerts'], relayTo: { prefix: BUS_TIME_RELAY, kinds: ['trip_updates', 'vehicle_positions'] } },
  ...NYC_BUS_FEEDS.map(feedId => ({ namespace: `nyc:${feedId}`, feedId, auth: busTimeKey, budget: { requestsPerHour: 240, safetyFactor: 1, reserveForStatic: 0 },
    tripMatching: 'exact' as const, matchWindowSeconds: 3600, kinds: ['trip_updates', 'vehicle_positions'] as const, relayFrom: BUS_TIME_RELAY }))],
};

/** Every static feed a source's realtime describes. */
export function sourceFeedIds(policy: RealtimeSourcePolicy): readonly string[] {
  return [policy.feedId, ...policy.alsoFeedIds ?? []];
}

export interface RealtimeSource { coverage: CoverageManifest; policy: RealtimeSourcePolicy; feeds: readonly RealtimeFeedSpec[] }

function source(coverage: CoverageManifest, policy: RealtimeSourcePolicy): RealtimeSource | undefined {
  const feeds = (coverage.feeds.find(feed => feed.id === policy.feedId)?.realtime ?? []).filter(spec => !policy.kinds || policy.kinds.includes(spec.kind));
  return feeds.length ? { coverage, policy, feeds } : undefined;
}

/** The source describing one feed; the coverage's primary feed when `feedId` is omitted. */
export function getRealtimeSource(coverageId: string, feedId?: string): RealtimeSource | undefined {
  return getRealtimeSources(coverageId).find(item => feedId === undefined || sourceFeedIds(item.policy).includes(feedId));
}

/** Every configured feed source, of one coverage or of all, primary feed first. */
export function getRealtimeSources(coverageId?: string): RealtimeSource[] {
  const ids = coverageId === undefined ? Object.keys(policies) : [getCoverage(coverageId)?.id ?? ''];
  return ids.flatMap(id => { const coverage = getCoverage(id); return coverage ? (policies[coverage.id] ?? []).flatMap(policy => source(coverage, policy) ?? []) : []; });
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
  // A relay stores documents for other coordinators; it publishes nothing of those kinds.
  return new Set(source.feeds.flatMap(feed => [feed.kind, ...feed.alsoPublishes ?? []]).filter(kind => !source.policy.relayTo?.kinds.includes(kind)));
}

export function feedParts(spec: RealtimeFeedSpec): readonly { id: string; url: URL }[] {
  if (spec.parts?.length) return spec.parts;
  if (!spec.url) throw new Error('Realtime feed has no upstream');
  return [{ id: spec.kind, url: spec.url }];
}

export function upstreamRequest(source: RealtimeSource, url: URL, env: Env, accept = 'application/x-google-protobuf'): Request {
  const headers: Record<string, string> = { accept };
  const target = new URL(url);
  const key = credential(source, env);
  if (key === null) throw new Error('upstream_credential_missing');
  if (key !== undefined && source.policy.auth.kind === 'query_token') target.searchParams.set(source.policy.auth.param ?? 'api_key', key);
  if (key !== undefined && source.policy.auth.kind === 'header') headers[source.policy.auth.header] = key;
  return new Request(target, { headers });
}
