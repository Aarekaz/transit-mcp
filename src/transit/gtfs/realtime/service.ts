import type { Env } from '../../../types';
import type { RegionalTransitService } from '../../../mcp/context';
import type { FeedRead } from './hub-core';
import type { NormalizedVehicle } from './decode';

export function createRegionalTransitService(env: Env): RegionalTransitService {
  return {
    async getVehiclePositions(nowSeconds: number): Promise<FeedRead<NormalizedVehicle[]>> {
      if (!env.REGION_FEED_HUB) {
        throw new Error('Bay Area regional service is not configured');
      }
      const id = env.REGION_FEED_HUB.idFromName('sfbay');
      const response = await env.REGION_FEED_HUB.get(id).fetch(
        `https://region-feed-hub.internal/vehicle_positions?now=${nowSeconds}`,
      );
      if (!response.ok) throw new Error('Bay Area regional service is unavailable');
      return response.json<FeedRead<NormalizedVehicle[]>>();
    },
  };
}
