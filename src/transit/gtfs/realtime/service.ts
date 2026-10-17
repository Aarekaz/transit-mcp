import type { Env } from '../../../types';
import type { RegionalTransitService } from '../../../mcp/context';
import type { FeedRead } from './hub-core';
import type { NormalizedVehicle } from './decode';
import type { NormalizedAlert, NormalizedStopUpdate } from './decode';
import { searchStops, type StaticTransitArtifact } from '../static/artifact';

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
    return artifact;
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
    async searchStations(query) {
      const artifact = await readArtifact();
      return searchStops(artifact, query).map(stop => ({
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
      return { ...feed, payload: feed.payload?.filter(update => stopIds.has(update.stopId)) ?? null };
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
