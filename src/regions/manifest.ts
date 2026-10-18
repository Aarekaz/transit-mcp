import type { PublicCity, RegionMode } from './types';
import { getCoverages, type CoverageWorkerBindings } from '../transit/core/coverage';
export { getCoverage, getCoverages } from '../transit/core/coverage';

const REGION_MODES = new Set<RegionMode>(['off', 'dark', 'on', 'suspended']);

export function normalizeRegionMode(value: string | undefined): RegionMode {
  return REGION_MODES.has(value as RegionMode) ? value as RegionMode : 'off';
}

/** Global rollout configuration; malformed registries never activate a coverage.
 * SF retains its existing mode binding, shared with its ingestion coordinator. */
export function getCoverageMode(id: string, bindings: CoverageWorkerBindings): RegionMode {
  if (id === 'sfbay') return normalizeRegionMode(bindings.SFBAY_MODE);
  try {
    const modes: unknown = JSON.parse(bindings.TRANSIT_COVERAGE_MODES ?? '{}');
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return 'off';
    const known = new Set(getCoverages().map(coverage => coverage.id));
    if (Object.entries(modes).some(([key, mode]) => !known.has(key) || !REGION_MODES.has(mode as RegionMode))) return 'off';
    return known.has(id) && Object.hasOwn(modes, id) ? normalizeRegionMode((modes as Record<string, RegionMode>)[id]) : 'off';
  } catch { return 'off'; }
}

export function getPublicCities(mode: RegionMode): readonly PublicCity[] {
  return mode === 'on' || mode === 'suspended'
    ? ['dc', 'nyc', 'sfbay']
    : ['dc', 'nyc'];
}
