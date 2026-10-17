import type { PublicCity } from './types';

/** IDs are opaque, case-sensitive values. Encoding happens only at URI boundaries. */
export function encodeTransitId(id: string): string {
  return id;
}

export function transitResourceUri(
  region: PublicCity,
  collection: 'stops' | 'routes' | 'trips' | 'vehicles',
  id: string,
): string {
  return `transit://${collection}/${region}/${encodeURIComponent(id)}`;
}
