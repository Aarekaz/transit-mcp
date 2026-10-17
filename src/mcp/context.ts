import type { SupportedCity } from '../transit/base';
import type { Env } from '../types';
import type { FeedRead } from '../transit/gtfs/realtime/hub-core';
import type { NormalizedVehicle } from '../transit/gtfs/realtime/decode';

export interface RegionalTransitService {
  getVehiclePositions(nowSeconds: number): Promise<FeedRead<NormalizedVehicle[]>>;
}

export interface RequestDeps {
  regionalTransitService: RegionalTransitService;
}

export interface MetroMcpContext {
  env: Env;
  era: 'modern' | 'legacy';
  deps?: Partial<RequestDeps>;
}

export type MetroRequestState = {
  phase: 'station-selection';
  tool: 'get_station_predictions';
  city: SupportedCity;
  query: string;
  candidateIds: string[];
};
