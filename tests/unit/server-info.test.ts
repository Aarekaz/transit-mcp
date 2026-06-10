import { describe, expect, it } from 'vitest';
import { getServerInfo } from '../../src/server-info';

describe('getServerInfo', () => {
  it('reports the current official station totals', () => {
    const body = getServerInfo('https://metro-mcp.example.test', '2026-06-10T19:00:00.000Z');

    expect(body.cities.find(city => city.code === 'dc')?.stations).toBe(102);
    expect(body.cities.find(city => city.code === 'nyc')?.stations).toBe(496);
    expect(body.stats.totalStations).toBe(598);
  });
});
