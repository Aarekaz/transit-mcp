import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetroMcpServer } from '../../src/mcp/server';
import { itinerarySchema } from '../../src/mcp/tools/global/plan';
import { parseTransitRef } from '../../src/transit/core/refs';
import { compactCoverage } from '../../src/transit/planner/compactor';
import { compactPrefix } from '../../src/transit/planner/network-plan';
import { validateItinerary } from '../../src/transit/planner/validator';
import { createMockEnv } from '../setup';
import { modernMcpRequest, readMcpResponse } from '../helpers/mcp-request';
import { memoryStorage } from '../helpers/realtime-fixture';
import { corpus, sfBayCorpusFixture, type CorpusScenario } from '../helpers/sfbay-corpus';
import type { Env } from '../../src/types';

async function call(env: Env, name: string, args: Record<string, unknown>) {
  const handler = createMcpHandler(ctx => createMetroMcpServer({ env, era: ctx.era, toolRequest: { name, arguments: args } }));
  try {
    const messages = await readMcpResponse(await handler.fetch(await modernMcpRequest('tools/call', { name, arguments: args })));
    return (messages[0] as { result: { isError?: boolean; structuredContent: Record<string, any> } }).result;
  } finally { await handler.close(); }
}
// SF Bay as production runs it: the whole-feed search withheld, the network planner on.
const networkEnv = (fixture: Awaited<ReturnType<typeof sfBayCorpusFixture>>) => createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub,
  TRANSIT_PLANNING_OFF: '["sfbay"]', TRANSIT_NETWORK_PLANNING: '["sfbay"]' });

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(corpus.now)); });
afterEach(() => vi.useRealTimers());

describe('network planner through plan_trip', () => {
  // The same literal oracle as the whole-feed corpus test: proposals from the compact search
  // must still come back as the exact, validated journeys, realtime and pathways included.
  it.each(corpus.journeys)('$name', async journey => {
    const fixture = await sfBayCorpusFixture(journey.realtime as CorpusScenario, memoryStorage().bucket, corpus.files, true);
    expect((await compactCoverage(fixture.bucket, 'sfbay', Date.parse(corpus.now))).built).toBe(2);
    const result = await call(networkEnv(fixture), 'plan_trip', { coverage: 'Bay Area', origin: { query: journey.origin }, destination: { query: journey.destination },
      departAt: journey.departAt, windowSeconds: 7200, maxWalkMetres: 100, maxTransfers: 2 });
    expect(result.isError).not.toBe(true);
    const output = result.structuredContent;
    expect(output.status).toBe(journey.want.status);
    if ('reason' in journey.want) expect(output.reasons).toContain(journey.want.reason);
    if (!journey.want.trips.length) { expect(output.itineraries).toEqual([]); expect(output.routeHints).toBeDefined(); return; }
    const itinerary = itinerarySchema.parse(output.itineraries[0]);
    const transit = itinerary.legs.filter(leg => leg.kind === 'transit');
    expect(transit.map(leg => parseTransitRef(leg.tripRef)!.id)).toEqual(journey.want.trips);
    expect(transit.map(leg => leg.mode)).toEqual(journey.want.modes);
    expect(new Date(itinerary.arrivalTime).toISOString()).toBe(journey.want.arrivalTime);
    expect(itinerary.transfers).toBe(journey.want.transfers);
    expect(itinerary.legs.filter(leg => leg.kind === 'walk').map(leg => leg.pathwayId)).toEqual(journey.want.pathways);
    for (const raw of output.itineraries) {
      expect(await validateItinerary(itinerarySchema.parse(raw) as Parameters<typeof validateItinerary>[0], fixture.source)).toMatchObject({ valid: true, reasons: [] });
    }
    // A returned journey rechecks as returned, endpoints and window included.
    if (journey.realtime === 'scheduled') {
      const { steps: _steps, ...itinerary } = output.itineraries[0];
      expect((await call(networkEnv(fixture), 'get_service_status', { itinerary })).structuredContent.journeyValid).toBe(true);
    }
  });

  // Breaks if a missing compact band lets the withheld whole-feed search run, or errors.
  it('says planning is unavailable, with route hints, until the compact bands are built', async () => {
    // A distinct timetable: bands of the corpus loaded by earlier cases stay in this isolate.
    const files = { ...corpus.files, 'stops.txt': `${corpus.files['stops.txt']}syn_unbuilt,Unbuilt stop,37.5,-122.5\n` };
    const fixture = await sfBayCorpusFixture('scheduled', memoryStorage().bucket, files, true);
    const result = await call(networkEnv(fixture), 'plan_trip', { coverage: 'Bay Area', origin: { query: 'Pier 39' }, destination: { query: 'SFO' }, departAt: corpus.now, maxWalkMetres: 100 });
    expect(result.structuredContent.reasons).toContain('PLANNING_UNAVAILABLE');
    expect(result.structuredContent.itineraries).toEqual([]);
    expect(result.structuredContent.routeHints.origin.length).toBeGreaterThan(0);
  });

  // Breaks if a damaged compact band fails the call instead of planning as before.
  it('plans as before when a compact band cannot be read', async () => {
    const files = { ...corpus.files, 'stops.txt': `${corpus.files['stops.txt']}syn_damaged,Damaged stop,37.6,-122.6\n` };
    const fixture = await sfBayCorpusFixture('scheduled', memoryStorage().bucket, files, true);
    await compactCoverage(fixture.bucket, 'sfbay', Date.parse(corpus.now));
    for (const object of (await fixture.bucket.list({ prefix: compactPrefix('sfbay') })).objects) await fixture.bucket.put(object.key, new Uint8Array(16));
    const result = await call(networkEnv(fixture), 'plan_trip', { coverage: 'Bay Area', origin: { query: 'Pier 39' }, destination: { query: 'SFO' }, departAt: corpus.now, maxWalkMetres: 100 });
    expect(result.structuredContent.reasons).toEqual(['PLANNING_UNAVAILABLE']);
    const open = await call(createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub, TRANSIT_NETWORK_PLANNING: '["sfbay"]' }), 'plan_trip',
      { coverage: 'Bay Area', origin: { query: 'Pier 39' }, destination: { query: 'SFO' }, departAt: corpus.now, maxWalkMetres: 100 });
    expect(open.structuredContent.itineraries).toHaveLength(1);
  });

  // Breaks if the switch is ignored: without it plan_trip behaves exactly as before.
  it('leaves planning unchanged where the network planner is off', async () => {
    const fixture = await sfBayCorpusFixture('scheduled', memoryStorage().bucket, corpus.files, true);
    await compactCoverage(fixture.bucket, 'sfbay', Date.parse(corpus.now));
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub, TRANSIT_PLANNING_OFF: '["sfbay"]' });
    const result = await call(env, 'plan_trip', { coverage: 'Bay Area', origin: { query: 'Pier 39' }, destination: { query: 'SFO' }, departAt: corpus.now, maxWalkMetres: 100 });
    expect(result.structuredContent.reasons).toEqual(['PLANNING_UNAVAILABLE']);
  });

  // Breaks if the cron rebuilds what exists or keeps bands no artifact references.
  it('builds each band once and removes bands of unreferenced shards', async () => {
    const fixture = await sfBayCorpusFixture('scheduled', memoryStorage().bucket, corpus.files, true);
    const now = Date.parse(corpus.now);
    await fixture.bucket.put(`${compactPrefix('sfbay')}${'0'.repeat(64)}-${'0'.repeat(16)}.bin`, new Uint8Array(8));
    expect(await compactCoverage(fixture.bucket, 'sfbay', now, 1)).toMatchObject({ built: 1, missing: 1, deleted: 0 });
    expect(await compactCoverage(fixture.bucket, 'sfbay', now)).toMatchObject({ built: 1, missing: 0, deleted: 0 });
    // Unreferenced bands go only once old enough.
    expect(await compactCoverage(fixture.bucket, 'sfbay', now + 3 * 3600_000)).toMatchObject({ built: 0, deleted: 1 });
    expect((await fixture.bucket.list({ prefix: compactPrefix('sfbay') })).objects).toHaveLength(2);
  });
});
