import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetroMcpServer } from '../../src/mcp/server';
import { itinerarySchema } from '../../src/mcp/tools/global/plan';
import { parseTransitRef } from '../../src/transit/core/refs';
import { validateItinerary } from '../../src/transit/planner/validator';
import { createRegionalTransitService } from '../../src/transit/gtfs/realtime/service';
import { createMockEnv } from '../setup';
import { modernMcpRequest, readMcpResponse } from '../helpers/mcp-request';
import { corpus, corpusRef, sfBayCorpusFixture, type CorpusScenario } from '../helpers/sfbay-corpus';
import type { Env } from '../../src/types';

async function call(env: Env, name: string, args: Record<string, unknown>) {
  const handler = createMcpHandler(ctx => createMetroMcpServer({ env, era: ctx.era, toolRequest: { name, arguments: args } }));
  try {
    const response = await handler.fetch(await modernMcpRequest('tools/call', { name, arguments: args }));
    expect(response.status).toBe(200);
    const messages = await readMcpResponse(response);
    expect(messages).toHaveLength(1);
    const envelope = messages[0] as { error?: unknown; result: { isError?: boolean; structuredContent: Record<string, any> } };
    expect(envelope.error).toBeUndefined();
    return envelope.result;
  } finally { await handler.close(); }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(corpus.now)); });
afterEach(() => vi.useRealTimers());

describe('SF Bay synthetic acceptance corpus through global MCP tools', () => {
  // Breaks if public alias expansion is removed or reduced to provider-ID guessing.
  it('resolves SFO to the canonical airport stop even without the abbreviation in the feed', async () => {
    const fixture = await sfBayCorpusFixture();
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket });
    const result = await call(env, 'find_transit', { query: ' SFO ', coverage: 'SF' });
    expect(result.structuredContent.candidates.map((candidate: { providerId: string }) => candidate.providerId)).toEqual(['syn_airport_rail']);
  });

  it('retains every exact airport identity despite a display limit and excludes unrelated names and routes', async () => {
    const fixture = await sfBayCorpusFixture('scheduled', undefined, { ...corpus.files,
      'stops.txt': corpus.files['stops.txt'] +
        'syn_airport_second,San Francisco International Airport,37.6158,-122.3921\n' +
        'syn_airport_office,San Francisco International Airport Maintenance,37.62,-122.39\n',
      'routes.txt': corpus.files['routes.txt'] + 'syn_false_route,syn_muni,,San Francisco International Airport,3\n',
    });
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket });
    const found = await call(env, 'find_transit', { query: 'sfo', coverage: 'SF', limit: 1 });
    expect(found.structuredContent.candidates.map((candidate: { providerId: string }) => candidate.providerId)).toEqual(['syn_airport_rail', 'syn_airport_second']);
    const plan = await call(env, 'plan_trip', { coverage: 'SF', origin: { query: 'Pier 39' }, destination: { query: 'SFO' } });
    expect(plan.isError).toBe(true);
    expect(plan.structuredContent.code).toBe('ENTITY_AMBIGUOUS');
    expect(plan.structuredContent.candidates.map((candidate: { providerId: string }) => candidate.providerId)).toEqual(['syn_airport_rail', 'syn_airport_second']);
    expect(plan.structuredContent).not.toHaveProperty('itineraries');
  });

  it('does not invent an airport entity when the reviewed target is missing from the artifact', async () => {
    const fixture = await sfBayCorpusFixture('scheduled', undefined, { ...corpus.files,
      'stops.txt': corpus.files['stops.txt'].replace('San Francisco International Airport', 'Unreviewed airport stop'),
    });
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket });
    expect((await call(env, 'find_transit', { query: 'SFO' })).structuredContent.candidates).toEqual([]);
    const result = await call(env, 'plan_trip', { coverage: 'SF', origin: { query: 'Pier 39' }, destination: { query: 'SFO' } });
    expect(result.structuredContent.code).toBe('ENTITY_NOT_FOUND');
    expect(result.structuredContent).not.toHaveProperty('itineraries');
  });

  // Literal expectations catch wrong agency/mode joins, missing pathway time, ignored
  // stale/canceled updates, and unsafe connections. Nothing derives the oracle from routing.
  it.each(corpus.journeys)('$name', async journey => {
    const fixture = await sfBayCorpusFixture(journey.realtime as CorpusScenario);
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub });
    const result = await call(env, 'plan_trip', { coverage: 'Bay Area', origin: { query: journey.origin }, destination: { query: journey.destination },
      departAt: journey.departAt, windowSeconds: 7200, maxWalkMetres: 100, maxTransfers: 2 });
    expect(result.isError).not.toBe(true);
    const output = result.structuredContent;
    expect(output.status).toBe(journey.want.status);
    if ('reason' in journey.want) expect(output.reasons).toContain(journey.want.reason);
    expect(output.itineraries).toHaveLength(journey.want.trips.length ? 1 : 0);
    for (const raw of output.itineraries) {
      const itinerary = itinerarySchema.parse(raw);
      const transit = itinerary.legs.filter(leg => leg.kind === 'transit');
      expect(transit.map(leg => parseTransitRef(leg.tripRef)!.id)).toEqual(journey.want.trips);
      expect(transit.map(leg => parseTransitRef(leg.agencyRef)!.id)).toEqual(journey.want.agencies);
      expect(transit.map(leg => leg.mode)).toEqual(journey.want.modes);
      expect(new Date(itinerary.arrivalTime).toISOString()).toBe(journey.want.arrivalTime);
      expect(itinerary.transfers).toBe(journey.want.transfers);
      expect(itinerary.legs.filter(leg => leg.kind === 'walk').map(leg => leg.pathwayId)).toEqual(journey.want.pathways);
      expect(itinerary.legs.every(leg => leg.validatorOutcome === 'valid')).toBe(true);
      // Recheck every returned journey against immutable canonical schedules and decoded RT.
      expect(await validateItinerary(itinerary as Parameters<typeof validateItinerary>[0], fixture.source)).toMatchObject({ valid: true, reasons: [], legFailures: [], transferFailures: [] });
    }
  });

  it('returns both ambiguous places and never guesses a journey', async () => {
    const fixture = await sfBayCorpusFixture(), query = corpus.queries.ambiguous;
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub });
    const result = await call(env, 'plan_trip', { coverage: 'SF', origin: { query: query.origin }, destination: { query: query.destination } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('ENTITY_AMBIGUOUS');
    expect(result.structuredContent.candidates.map((candidate: { providerId: string }) => candidate.providerId)).toEqual(query.candidates);
    expect(result.structuredContent).not.toHaveProperty('itineraries');
  });

  it('returns only the matching agency alert with sanitized agency text', async () => {
    const fixture = await sfBayCorpusFixture('alert'), query = corpus.queries.alert;
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub });
    const result = await call(env, 'get_service_status', { ref: corpusRef('route', query.route) });
    expect(result.structuredContent.status).toBe('realtime');
    expect(result.structuredContent.alerts.map((alert: { id: string }) => alert.id)).toEqual(query.ids);
    expect(result.structuredContent.alerts[0].agencyText).toMatchObject({ title: query.title, label: 'agency_supplied' });
  });

  it.each(['delayed', 'stale', 'canceled'] as const)('uses the same %s schedule/realtime facts for global departures and the regional service', async scenario => {
    const fixture = await sfBayCorpusFixture(scenario), query = corpus.queries.departures;
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub });
    const result = await call(env, 'get_departures', { stopRef: corpusRef('stop', query.stop), at: corpus.now, windowSeconds: 1800 });
    const regional = await createRegionalTransitService(env).getStationPredictions(query.stop, Date.parse(corpus.now) / 1000);
    expect(result.structuredContent.departures).toHaveLength(scenario === 'canceled' ? 0 : 1);
    expect(regional.payload).toHaveLength(scenario === 'canceled' ? 0 : 1);
    if (scenario !== 'canceled') {
      const expected = scenario === 'delayed' ? query.predictedTime : query.scheduledTime;
      expect(result.structuredContent.departures[0]).toMatchObject({ tripRef: corpusRef('trip', query.trip),
        predictedTime: scenario === 'delayed' ? query.predictedTime : null,
        status: scenario === 'delayed' ? 'realtime' : 'scheduled_only' });
      expect(new Date(result.structuredContent.departures[0].scheduledTime).toISOString()).toBe(query.scheduledTime);
      expect(regional.payload![0]!.departureTimeSeconds).toBe(Date.parse(expected) / 1000);
    }
  });

  it.each(['home', 'work'])('keeps the personal %s meaning with the client and accepts client-resolved coordinates', async query => {
    const fixture = await sfBayCorpusFixture();
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: fixture.bucket, REGION_FEED_HUB: fixture.hub });
    expect((await call(env, 'find_transit', { query })).structuredContent.candidates).toEqual([]);
    expect((await call(env, 'plan_trip', { coverage: 'sfbay', origin: { query }, destination: { query: 'Embarcadero Muni' } })).structuredContent.code).toBe('ENTITY_NOT_FOUND');
    const result = await call(env, 'plan_trip', { origin: { latitude: 37.8087, longitude: -122.4098 }, destination: { ref: corpusRef('stop', 'syn_muni_emb') },
      departAt: corpus.now, maxWalkMetres: 0 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.itineraries).toHaveLength(1);
    expect(new Date(result.structuredContent.itineraries[0].arrivalTime).toISOString()).toBe('2026-10-19T16:12:00.000Z');
  });
});
