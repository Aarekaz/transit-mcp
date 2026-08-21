import type { SupportedCity } from '../transit/base';
import type { Env } from '../types';

export type RequestDeps = Record<string, never>;

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
