import type { Env } from '../../../types';
import type { RegionalTransitService } from '../../../mcp/context';
import type { FeedRead } from './hub-core';
import type { NormalizedVehicle, NormalizedAlert, NormalizedStopUpdate } from './decode';
import { StaticArtifactStore, readBoundedObject, SF511_QUOTA_NAMESPACE, type StaticVersion } from './snapshot-store';
import { decodeDiscoveryIndex, sha256 } from '../static/shards';
import type { ArtifactManifestV2, DiscoveryIndex } from '../static/schema';
import { parseTransitRef, type TransitRef } from '../../core/refs';
import { getScheduledDepartures } from '../../planner/departures';
import { sanitizeTransitText } from './freshness';

// The isolate retains one manifest per bound bucket, and no decoded timetable.
const artifactStores = new WeakMap<R2Bucket, StaticArtifactStore>();

export function createRegionalTransitService(env: Env): RegionalTransitService {
  const bucket = () => {
    if (!env.TRANSIT_ARTIFACTS) throw new Error('Bay Area static artifact is not configured');
    return env.TRANSIT_ARTIFACTS;
  };
  const current = async () => {
    const binding = bucket();
    let store = artifactStores.get(binding);
    if (!store) { store = new StaticArtifactStore(binding); artifactStores.set(binding, store); }
    const result = await store.current();
    if (!result) throw new Error('Bay Area static artifact is unavailable');
    return result;
  };
  const discovery = async (manifest: ArtifactManifestV2): Promise<DiscoveryIndex[]> => {
    const indexes: DiscoveryIndex[] = []; let total = 0;
    for (const descriptor of manifest.discoveries) {
      total += descriptor.byteLength;
      if (total > 64 * 1024 * 1024) throw new Error('Discovery byte budget exceeded');
      const bytes = await readBoundedObject(bucket(), descriptor.key, descriptor.byteLength);
      if (bytes.length !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Discovery integrity failure');
      const index = decodeDiscoveryIndex(bytes);
      const sources = manifest.sources.filter(source => source.feedId === descriptor.feedId);
      if (index.schemaVersion !== 2 || index.coverageId !== manifest.coverageId || index.feedId !== descriptor.feedId || sources.length !== 1 ||
        index.sourceSha256 !== sources[0]!.sha256 || !Array.isArray(index.stops) || !Array.isArray(index.routes)) throw new Error('Discovery identity mismatch');
      for (const record of [...index.stops, ...index.routes]) {
        const ref = parseTransitRef(record.ref);
        if (!ref || ref.coverage !== index.coverageId || ref.feed !== index.feedId || ref.id !== record.providerId) throw new Error('Discovery identity mismatch');
      }
      indexes.push(index);
    }
    return indexes;
  };
  const readFeed = async <T>(kind: string, nowSeconds: number, version: StaticVersion, stops: string[] = []): Promise<FeedRead<T>> => {
    if (!env.REGION_FEED_HUB) throw new Error('Bay Area regional service is not configured');
    const url = new URL(`https://region-feed-hub.internal/${kind}`);
    url.searchParams.set('now', String(nowSeconds)); url.searchParams.set('artifact', version.artifactVersion);
    for (const stop of stops) url.searchParams.append('stop', stop);
    const response = await env.REGION_FEED_HUB.get(env.REGION_FEED_HUB.idFromName(SF511_QUOTA_NAMESPACE)).fetch(url.href);
    if (!response.ok) throw new Error('Bay Area regional service is unavailable');
    return response.json<FeedRead<T>>();
  };
  return {
    async searchStations(query, limit = 20) {
      const { manifest } = await current(), normalized = query.trim().toLocaleLowerCase('en-US');
      if (!normalized || limit <= 0) return [];
      const results = (await discovery(manifest)).flatMap(index => index.stops.filter(stop => stop.latitude !== null && stop.longitude !== null &&
        (stop.providerId.toLowerCase().includes(normalized) || stop.name.toLowerCase().includes(normalized))).map(stop => ({
          id: stop.providerId, name: sanitizeTransitText(stop.name), latitude: stop.latitude!, longitude: stop.longitude!, locationType: stop.locationType,
          parentStationId: stop.parentStationRef ? parseTransitRef(stop.parentStationRef)?.id : undefined,
          routeIds: (index.stopRoutes[stop.ref] ?? []).map(ref => parseTransitRef(ref)!.id),
        })));
      return results.sort((a, b) => Number(b.locationType === 1) - Number(a.locationType === 1) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, limit);
    },
    async getRoutes() {
      const { manifest } = await current();
      return (await discovery(manifest)).flatMap(index => index.routes.map(route => ({ id: route.providerId, shortName: sanitizeTransitText(route.shortName, 120),
        longName: sanitizeTransitText(route.longName), mode: route.mode, color: route.color })));
    },
    async getStationPredictions(stationId, nowSeconds) {
      const { manifest, version } = await current(), indexes = await discovery(manifest);
      const matches = indexes.flatMap(index => index.stops.filter(stop => stop.providerId === stationId).map(stop => ({ index, stop })));
      if (matches.length !== 1) throw new Error('Unknown or ambiguous Bay Area station');
      const { index, stop } = matches[0]!;
      const stopIds = index.stops.filter(s => s.ref === stop.ref || s.parentStationRef === stop.ref).map(s => s.providerId);
      const feed = await readFeed<NormalizedStopUpdate[]>('trip_updates', nowSeconds, version, stopIds);
      const schedule = await getScheduledDepartures({ manifest, stopRef: stop.ref as TransitRef,
        instant: new Date(nowSeconds * 1000).toISOString(), windowSeconds: 6 * 3600, limit: 100,
        readShard: key => readBoundedObject(bucket(), key, 64 * 1024 * 1024), readDiscovery: key => readBoundedObject(bucket(), key, 64 * 1024 * 1024) });
      const usable = feed.status === 'realtime' && feed.version?.artifactVersion === version.artifactVersion;
      const updates = usable ? feed.payload ?? [] : [];
      const callKey = (instance: string, sequence: number | undefined, stopId: string) => JSON.stringify([instance, sequence, stopId]);
      const byCall = new Map(updates.filter(update => update.tripInstanceRef).map(update => [callKey(update.tripInstanceRef!, update.stopSequence, update.stopId), update]));
      const payload: NormalizedStopUpdate[] = [];
      const used = new Set<NormalizedStopUpdate>();
      const appendUpdate = (update: NormalizedStopUpdate): boolean => {
        if (used.has(update)) return true;
        used.add(update);
        if (update.status === 'canceled' || update.status === 'skipped') return true;
        if (update.status === 'realtime') { payload.push(update); return true; }
        // Non-exact frequency template offsets are not precise scheduled calls.
        if (update.scheduleRelationship === 'UNSCHEDULED') return true;
        if (update.status === 'scheduled_only' && (update.scheduledArrivalTimeSeconds !== undefined || update.scheduledDepartureTimeSeconds !== undefined)) {
          payload.push({ ...update, arrivalTimeSeconds: update.scheduledArrivalTimeSeconds, departureTimeSeconds: update.scheduledDepartureTimeSeconds });
          return true;
        }
        return false;
      };
      for (const departure of schedule.departures) {
        const update = byCall.get(callKey(departure.tripInstanceRef, departure.stopSequence, parseTransitRef(departure.stopRef)!.id));
        if (update && appendUpdate(update)) continue;
        const time = Date.parse(departure.scheduledTime) / 1000;
        payload.push({ entityId: `scheduled:${departure.tripInstanceRef}:${departure.stopSequence}`, tripId: parseTransitRef(departure.tripRef)!.id,
          tripInstanceRef: departure.tripInstanceRef, stopId: parseTransitRef(departure.stopRef)!.id, stopSequence: departure.stopSequence,
          routeId: parseTransitRef(departure.routeRef)!.id, serviceDate: departure.serviceDate, arrivalTimeSeconds: time, departureTimeSeconds: time, status: 'scheduled_only' });
      }
      for (const update of updates) {
        if (stopIds.includes(update.stopId)) appendUpdate(update);
      }
      const result = payload.filter(row => (row.arrivalTimeSeconds ?? row.departureTimeSeconds ?? 0) >= nowSeconds - 30)
        .sort((a, b) => (a.arrivalTimeSeconds ?? a.departureTimeSeconds ?? 0) - (b.arrivalTimeSeconds ?? b.departureTimeSeconds ?? 0));
      return { ...feed, version, payload: result, status: usable ? 'realtime' : schedule.status,
        warnings: [...feed.warnings, ...schedule.reasons, ...(!usable ? ['scheduled_fallback'] : [])] };
    },
    async getAlerts(nowSeconds) { return readFeed<NormalizedAlert[]>('service_alerts', nowSeconds, (await current()).version); },
    async getVehiclePositions(nowSeconds) { return readFeed<NormalizedVehicle[]>('vehicle_positions', nowSeconds, (await current()).version); },
  };
}
