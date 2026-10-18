/**
 * Transit System Registry
 *
 * Central registry for all supported transit systems.
 * Provides factory function to instantiate the correct client based on city.
 */

import { SupportedCity, TransitAPIClient } from './base';
import { WMATAClient } from './wmata-client';
import { MTAClient } from './mta-client';
import { Env } from '../types';

// Global schedule-backed coverage and legacy native clients are distinct registries.
// Global handlers read immutable artifacts; they must not invoke these API clients.
export { getCoverage, getCoverages } from './core/coverage';

/**
 * Map of city codes to their client classes
 */
export const TRANSIT_CLIENTS = {
  dc: WMATAClient,
  nyc: MTAClient,
} as const;

/**
 * City metadata for display and validation
 */
export const CITY_INFO = {
  dc: {
    name: 'Washington DC Metro',
    shortName: 'DC Metro',
    system: 'WMATA',
    requiresApiKey: true,
  },
  nyc: {
    name: 'New York City Subway',
    shortName: 'NYC Subway',
    system: 'MTA',
    requiresApiKey: false,
  },
} as const;

/**
 * Get the appropriate transit client for a city
 *
 * @param city - City identifier ('dc' or 'nyc')
 * @param env - Cloudflare Workers environment bindings
 * @returns Instantiated transit client
 * @throws Error if city is not supported or API key is missing
 */
export function getTransitClient(city: SupportedCity, env: Env): TransitAPIClient {
  const ClientClass = TRANSIT_CLIENTS[city];

  if (!ClientClass) {
    throw new Error(`Unsupported transit system: ${city}`);
  }

  // Get API key based on city
  let apiKey: string | undefined;
  if (city === 'dc') {
    apiKey = env.WMATA_API_KEY;
    if (!apiKey) {
      throw new Error('WMATA_API_KEY is required for DC Metro');
    }
  }
  // MTA doesn't require an API key (public endpoints)

  // Instantiate client
  if (city === 'dc') {
    return new WMATAClient(apiKey!);
  } else {
    return new MTAClient();
  }
}

/**
 * Get list of all supported cities
 */
export function getSupportedCities(): SupportedCity[] {
  return Object.keys(TRANSIT_CLIENTS) as SupportedCity[];
}

/**
 * Check if a city is supported
 */
export function isSupportedCity(city: string): city is SupportedCity {
  return city in TRANSIT_CLIENTS;
}

/**
 * Get information about a city's transit system
 */
export function getCityInfo(city: SupportedCity) {
  return CITY_INFO[city];
}
