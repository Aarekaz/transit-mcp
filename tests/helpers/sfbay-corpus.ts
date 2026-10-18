import { transit_realtime } from 'gtfs-realtime-bindings';
import corpus from '../fixtures/sfbay-golden-journeys.json';
import { SFBAY_COVERAGE } from '../../src/regions/sfbay';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import { decodeRealtimeFeed } from '../../src/transit/gtfs/realtime/decode';
import { applyTripUpdates } from '../../src/transit/gtfs/realtime/trip-match';
import { RegionalFeedHubCore } from '../../src/transit/gtfs/realtime/hub-core';
import type { RealtimeFeedKind } from '../../src/regions/types';
import { formatEntityRef } from '../../src/transit/core/refs';
import type { GtfsScheduleFiles } from '../../src/transit/gtfs/static/schema';
import { memoryStorage } from './realtime-fixture';

export { corpus };
export type CorpusScenario = keyof typeof corpus.realtime;
export const corpusRef = (kind: 'stop' | 'route' | 'trip' | 'agency', id: string) => formatEntityRef({ coverage: 'sfbay', feed: 'sf511', kind, id });

/** Only storage and transport are substituted. Compile, decode, match and freshness are real. */
export async function sfBayCorpusFixture(scenario: CorpusScenario = 'scheduled', bucket = memoryStorage().bucket, files: GtfsScheduleFiles = corpus.files) {
  const compiled = await compileSchedule({ coverage: SFBAY_COVERAGE, feedId: 'sf511', files,
    window: { startDate: '20261019', endDate: '20261020' },
    source: { url: corpus.provenance.sourceUrl, retrievedAt: '2026-10-18T00:00:00Z' } });
  await bucket.put(compiled.manifest.discoveries[0]!.key, compiled.discoveryBytes);
  await bucket.put(compiled.manifest.shards[0]!.key, compiled.shardBytes);
  const version = await new StaticArtifactStore(bucket).publish(compiled.manifest);
  const nowSeconds = Date.parse(corpus.now) / 1000, event = corpus.realtime[scenario];
  const timestamp = nowSeconds - event.ageSeconds;
  const decoded = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0', timestamp }, entity: event.entities,
  }).finish());
  const applied = await applyTripUpdates(decoded, { manifest: compiled.manifest, shards: [compiled.shard], version, feedId: 'sf511' });
  const core = new RegionalFeedHubCore(SFBAY_COVERAGE.thresholds);
  const snapshot = { version, producerTimestampSeconds: timestamp, receivedAtSeconds: nowSeconds };
  core.replace('trip_updates', { ...snapshot, payload: applied.stopUpdates, degraded: applied.degraded, warnings: applied.warnings });
  core.replace('service_alerts', { ...snapshot, payload: decoded.alerts });
  const hub = {
    idFromName: () => 'fixture-sf511',
    get: () => ({ fetch: async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.searchParams.get('artifact') !== version.artifactVersion) throw new Error('Corpus hub artifact mismatch');
      const kind = url.pathname.slice(1);
      if (!['trip_updates', 'service_alerts', 'vehicle_positions'].includes(kind)) throw new Error('Unknown corpus feed');
      return Response.json(core.read(kind as RealtimeFeedKind, Number(url.searchParams.get('now'))));
    } }),
  } as unknown as DurableObjectNamespace;
  return { compiled, bucket, version, hub, core, source: {
    manifest: compiled.manifest, shards: [compiled.shard], now: corpus.now,
    realtimeMaxAgeSeconds: SFBAY_COVERAGE.thresholds.tripUpdates.realtimeSeconds,
    realtime: { ...snapshot, payload: applied.stopUpdates, degraded: applied.degraded },
  } };
}
