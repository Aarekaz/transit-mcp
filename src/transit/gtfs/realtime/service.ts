import type { Env } from '../../../types';
import type { RegionalTransitService } from '../../../mcp/context';
import type { FeedRead } from './hub-core';
import type { NormalizedVehicle } from './decode';
import type { NormalizedAlert, NormalizedStopUpdate } from './decode';
import { searchStops, type StaticTransitArtifact } from '../static/artifact';
import { SFBAY_REGION } from '../../../regions/sfbay';

const ARTIFACT_KEY = 'artifacts/sfbay/current.json';

function isStaticArtifact(value: unknown): value is StaticTransitArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StaticTransitArtifact>;
  return candidate.schemaVersion === 1
    && candidate.region === 'sfbay'
    && Array.isArray(candidate.stops)
    && Array.isArray(candidate.routes)
    && typeof candidate.stopRoutes === 'object'
    && candidate.stopRoutes !== null;
}

export function createRegionalTransitService(env: Env): RegionalTransitService {
  const readArtifact = async (): Promise<StaticTransitArtifact> => {
    if (!env.TRANSIT_ARTIFACTS) throw new Error('Bay Area static artifact is not configured');
    const object = await env.TRANSIT_ARTIFACTS.get(ARTIFACT_KEY);
    if (!object) throw new Error('Bay Area static artifact is unavailable');
    const artifact: unknown = await object.json();
    if (!isStaticArtifact(artifact)) throw new Error('Bay Area static artifact is invalid');
    const ageMs = Date.now() - Date.parse(artifact.generatedAt);
    if (!Number.isFinite(ageMs) || ageMs > SFBAY_REGION.static.maxStaticAgeDays * 86_400_000) {
      throw new Error('Bay Area static artifact is expired');
    }
    return artifact;
  };

  const scheduledUpdates = (artifact: StaticTransitArtifact, stopIds: Set<string>, nowSeconds: number): NormalizedStopUpdate[] => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: SFBAY_REGION.timezone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowSeconds * 1_000));
    const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
    const date = `${part('year')}${part('month')}${part('day')}`;
    const weekday = part('weekday').toLowerCase() as 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
    const localSeconds = Number(part('hour')) * 3600 + Number(part('minute')) * 60 + Number(part('second'));
    return (artifact.stopTimes ?? []).filter(item => {
      const calendar = artifact.calendars?.[item.serviceId];
      const exception = calendar?.exceptions[date];
      const active = exception === 1 || (exception !== 2 && calendar && date >= calendar.startDate && date <= calendar.endDate && calendar[weekday]);
      return stopIds.has(item.stopId) && active && item.arrivalSeconds >= localSeconds && item.arrivalSeconds <= localSeconds + 6 * 3600;
    }).map(item => ({
      entityId: `scheduled:${item.tripId}:${item.stopId}:${item.arrivalSeconds}`,
      tripId: item.tripId, routeId: item.routeId, stopId: item.stopId,
      arrivalTimeSeconds: nowSeconds + item.arrivalSeconds - localSeconds,
      departureTimeSeconds: nowSeconds + item.departureSeconds - localSeconds,
    })).sort((a, b) => (a.arrivalTimeSeconds ?? 0) - (b.arrivalTimeSeconds ?? 0));
  };

  const readFeed = async <T>(kind: string, nowSeconds: number): Promise<FeedRead<T>> => {
    if (!env.REGION_FEED_HUB) throw new Error('Bay Area regional service is not configured');
    const id = env.REGION_FEED_HUB.idFromName('sfbay');
    const response = await env.REGION_FEED_HUB.get(id).fetch(
      `https://region-feed-hub.internal/${kind}?now=${nowSeconds}`,
    );
    if (!response.ok) throw new Error('Bay Area regional service is unavailable');
    return response.json<FeedRead<T>>();
  };

  return {
    async searchStations(query, limit = 20) {
      const artifact = await readArtifact();
      return searchStops(artifact, query, limit).map(stop => ({
        ...stop,
        routeIds: artifact.stopRoutes[stop.id] ?? [],
      }));
    },
    async getStationPredictions(stationId, nowSeconds) {
      const artifact = await readArtifact();
      const station = artifact.stops.find(stop => stop.id === stationId);
      if (!station) throw new Error(`Unknown Bay Area station: ${stationId}`);
      const stopIds = new Set([
        stationId,
        ...artifact.stops
          .filter(stop => stop.parentStationId === stationId)
          .map(stop => stop.id),
      ]);
      const feed = await readFeed<NormalizedStopUpdate[]>('trip_updates', nowSeconds);
      const realtime = (feed.payload ?? [])
        .filter(update => stopIds.has(update.stopId) && (update.arrivalTimeSeconds ?? update.departureTimeSeconds ?? 0) >= nowSeconds - 30)
        .sort((a, b) => (a.arrivalTimeSeconds ?? a.departureTimeSeconds ?? 0) - (b.arrivalTimeSeconds ?? b.departureTimeSeconds ?? 0));
      if (realtime.length > 0 && (feed.freshness === 'fresh' || feed.freshness === 'stale')) return { ...feed, payload: realtime };
      return { ...feed, payload: scheduledUpdates(artifact, stopIds, nowSeconds), warnings: [...feed.warnings, 'scheduled_fallback'] };
    },
    async getRoutes() {
      return (await readArtifact()).routes;
    },
    async getAlerts(nowSeconds) {
      return readFeed<NormalizedAlert[]>('service_alerts', nowSeconds);
    },
    async getVehiclePositions(nowSeconds: number): Promise<FeedRead<NormalizedVehicle[]>> {
      return readFeed<NormalizedVehicle[]>('vehicle_positions', nowSeconds);
    },
  };
}
