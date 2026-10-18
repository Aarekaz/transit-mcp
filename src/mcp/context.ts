import type { SupportedCity } from '../transit/base';
import type { Env } from '../types';
import type { FeedRead } from '../transit/gtfs/realtime/hub-core';
import type { NormalizedVehicle } from '../transit/gtfs/realtime/decode';
import type { NormalizedAlert, NormalizedStopUpdate } from '../transit/gtfs/realtime/decode';
import type { ArtifactRoute, ArtifactStop } from '../transit/gtfs/static/artifact';

export type RegionalStation = ArtifactStop & { routeIds: string[] };

export interface RegionalTransitService {
  searchStations(query: string, limit?: number): Promise<RegionalStation[]>;
  getStationPredictions(stationId: string, nowSeconds: number): Promise<FeedRead<NormalizedStopUpdate[]>>;
  getRoutes(): Promise<ArtifactRoute[]>;
  getAlerts(nowSeconds: number): Promise<FeedRead<NormalizedAlert[]>>;
  getVehiclePositions(nowSeconds: number): Promise<FeedRead<NormalizedVehicle[]>>;
}

export interface RequestDeps {
  regionalTransitService: RegionalTransitService;
}

export interface MetroMcpContext {
  env: Env;
  era: 'modern' | 'legacy';
  deps?: Partial<RequestDeps>;
  /** Bounded HTTP envelope input used only by pre-dispatch signed-state verification. */
  toolRequest?: { name: string; arguments: unknown; inputResponses?: unknown };
}

export type LegacyStationRequestState = {
  phase: 'station-selection';
  tool: 'get_station_predictions';
  city: SupportedCity;
  query: string;
  candidateIds: string[];
};

export type TransitRequestState = LegacyStationRequestState | {
  phase: 'transit-selection';
  tool: 'plan_trip';
  requestHash: string;
  artifactVersion: string;
  candidates: Partial<Record<'origin' | 'destination', string[]>>;
};
export type MetroRequestState = TransitRequestState;
