import type { PublicCity, RegionMode } from './types';
export { getCoverage } from '../transit/core/coverage';

const REGION_MODES = new Set<RegionMode>(['off', 'dark', 'on', 'suspended']);

export function normalizeRegionMode(value: string | undefined): RegionMode {
  return REGION_MODES.has(value as RegionMode) ? value as RegionMode : 'off';
}

export function getPublicCities(mode: RegionMode): readonly PublicCity[] {
  return mode === 'on' || mode === 'suspended'
    ? ['dc', 'nyc', 'sfbay']
    : ['dc', 'nyc'];
}
