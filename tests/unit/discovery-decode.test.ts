import { describe, expect, it } from 'vitest';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { decodeDiscoveryIndex } from '../../src/transit/gtfs/static/shards';
import { plannerInput } from '../helpers/planner-fixture';

async function valid(): Promise<Record<string, any>> {
  const compiled = await compileSchedule(plannerInput());
  return JSON.parse(new TextDecoder().decode(compiled.discoveryBytes));
}
const decode = (index: unknown) => decodeDiscoveryIndex(new TextEncoder().encode(JSON.stringify(index)));

describe('decoding a discovery index', () => {
  it('accepts a compiled index unchanged', async () => {
    const index = await valid();
    expect(decode(index)).toEqual(index);
  });

  it.each([
    ['unsorted trip IDs', (index: any) => { index.tripProviderIds = ['b', 'a']; }],
    ['duplicate trip IDs', (index: any) => { index.tripProviderIds = ['a', 'a']; }],
    ['an empty trip ID', (index: any) => { index.tripProviderIds = ['', 'a']; }],
    ['a trip ID that is not a string', (index: any) => { index.tripProviderIds = [1, 2]; }],
    ['trip IDs that are not a list', (index: any) => { index.tripProviderIds = { a: 1 }; }],
    ['stop routes that are a list', (index: any) => { index.stopRoutes = []; }],
    ['a stop route keyed by a route', (index: any) => { const [stop, routes] = Object.entries(index.stopRoutes)[0]!; delete index.stopRoutes[stop]; index.stopRoutes[(routes as string[])[0]!] = routes; }],
    ['a stop route list holding a stop', (index: any) => { const stop = Object.keys(index.stopRoutes)[0]!; index.stopRoutes[stop] = [stop]; }],
    ['a stop route list that is not a list', (index: any) => { const stop = Object.keys(index.stopRoutes)[0]!; index.stopRoutes[stop] = index.stopRoutes[stop][0]; }],
    ['a route ref with an extra segment', (index: any) => { const stop = Object.keys(index.stopRoutes)[0]!; index.stopRoutes[stop] = [`${index.stopRoutes[stop][0]}:x`]; }],
  ])('refuses %s', async (_name, spoil) => {
    const index = await valid();
    spoil(index);
    expect(() => decode(index)).toThrow('Invalid discovery index');
  });
});
