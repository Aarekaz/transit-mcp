import { describe, expect, it } from 'vitest';
import { getPublicCities, normalizeRegionMode } from '../../src/regions/manifest';
import { SFBAY_REGION } from '../../src/regions/sfbay';

describe('regional transit manifests', () => {
  it('keeps Bay Area discovery dark until explicitly enabled', () => {
    expect(getPublicCities('off')).toEqual(['dc', 'nyc']);
    expect(getPublicCities('dark')).toEqual(['dc', 'nyc']);
    expect(getPublicCities('on')).toEqual(['dc', 'nyc', 'sfbay']);
    expect(getPublicCities('suspended')).toEqual(['dc', 'nyc', 'sfbay']);
  });

  it('defaults missing and malformed rollout modes to off', () => {
    expect(normalizeRegionMode(undefined)).toBe('off');
    expect(normalizeRegionMode('')).toBe('off');
    expect(normalizeRegionMode('enabled')).toBe('off');
    expect(normalizeRegionMode('dark')).toBe('dark');
  });

  it('publishes a region-neutral, quota-bounded sfbay manifest', () => {
    expect(SFBAY_REGION).toMatchObject({
      id: 'sfbay',
      displayName: 'San Francisco Bay Area',
      timezone: 'America/Los_Angeles',
      secretEnv: 'SF511_API_KEY',
      modeEnv: 'SFBAY_MODE',
      idStrategy: 'verbatim',
    });
    expect(SFBAY_REGION.realtime.budget.safetyFactor).toBeLessThan(1);
    expect(SFBAY_REGION.realtime.feeds.map(feed => feed.kind)).toEqual([
      'trip_updates',
      'vehicle_positions',
      'service_alerts',
    ]);
    expect(SFBAY_REGION.realtime.feeds.every(feed => feed.url.protocol === 'https:')).toBe(true);
  });
});
