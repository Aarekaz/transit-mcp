import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getCoverage, getPublicCities, normalizeRegionMode } from '../../src/regions/manifest';
import { SFBAY_REGION } from '../../src/regions/sfbay';

describe('regional transit manifests', () => {
  it('resolves Bay Area aliases to the permanent coverage ID without widening public discovery', () => {
    for (const alias of ['sfbay', 'SF', ' San Francisco ', 'Bay Area', 'San Francisco Bay Area']) {
      expect(getCoverage(alias)?.id).toBe('sfbay');
    }
    expect(getCoverage('unknown')).toBeUndefined();
    expect(getCoverage('91')).toBeUndefined();
    expect(getPublicCities('dark')).toEqual(['dc', 'nyc']);
  });

  it('provides source capability, threshold, timezone, and attribution metadata without credentials', () => {
    const coverage = getCoverage('sfbay');
    expect(coverage).toMatchObject({
      kind: 'region',
      capabilities: { schedules: true, realtimeDepartures: true, alerts: true, vehicles: true, planning: true, accessibility: true },
      agencyTimezones: {},
      thresholds: {
        tripUpdates: { realtimeSeconds: 180, staleSeconds: 600 },
        vehiclePositions: { realtimeSeconds: 360, unavailableSeconds: 600 },
        alerts: { currentSeconds: 1200 },
        minimumScheduleMatchRate: 0.5,
        maximumUnverifiedWalkMetres: 800,
      },
      attribution: [{ text: 'Transit data provided by 511 SF Bay and participating Bay Area operators.', url: 'https://511.org/open-data/transit' }],
    });
    expect(coverage?.feeds).toEqual([{ id: 'sf511', realtime: SFBAY_REGION.realtime.feeds }]);
    expect(coverage?.supportedModes).toEqual(expect.arrayContaining(['bus', 'rail', 'ferry']));
    expect(coverage).not.toHaveProperty('secretEnv');
    expect(coverage).not.toHaveProperty('modeEnv');
    expect(JSON.stringify(coverage)).not.toMatch(/api_key|SF511_API_KEY/);
  });

  it('does not interpret public places or client-owned personal meanings as coverage names', () => {
    for (const query of ['Pier 39', 'SFO', 'home', 'work']) expect(getCoverage(query)).toBeUndefined();
    expect(getPublicCities('dark')).toEqual(['dc', 'nyc']);
  });

  it('does not fabricate agency IDs from the consolidated feed namespace', () => {
    expect(getCoverage('sfbay')?.agencyTimezones).toEqual({});
  });

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

  it('uploads regional artifacts to remote R2 instead of local Wrangler storage', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['upload:sfbay-artifact']).toContain('--remote');
    expect(packageJson.scripts['upload:sfbay-artifact:preview']).toContain('--remote');
  });
});

describe('official station names as aliases', () => {
  it('finds DC stations by the names WMATA publishes and riders use', async () => {
    const { DC_COVERAGE } = await import('../../src/regions/dc');
    const stationFor = (alias: string) => DC_COVERAGE.placeAliases.filter(place => place.aliases.some(name => name.toLowerCase() === alias.toLowerCase())).flatMap(place => place.stopNames);
    expect(stationFor('Chinatown')).toEqual(['Gallery Place']);
    expect(stationFor('Gallery Pl-Chinatown')).toEqual(['Gallery Place']);
    expect(stationFor('Convention Center')).toEqual(['Mt Vernon Sq']);
    expect(stationFor('Adams Morgan')).toEqual(['Woodley Park']);
    // A name two stations share (GMU) would pick one silently; none is published twice.
    const owners = new Map<string, Set<string>>();
    for (const place of DC_COVERAGE.placeAliases) for (const alias of place.aliases) owners.set(alias.toLowerCase(), (owners.get(alias.toLowerCase()) ?? new Set()).add(place.stopNames.join('|')));
    expect([...owners].filter(([, stations]) => stations.size > 1)).toEqual([]);
    expect(stationFor('GMU')).toEqual([]);
  });
});
