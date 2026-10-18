import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetroMcpServer } from '../../src/mcp/server';
import { itinerarySchema } from '../../src/mcp/tools/global/plan';
import { getCoverage } from '../../src/transit/core/coverage';
import { formatEntityRef, formatTripInstanceRef, parseTransitRef } from '../../src/transit/core/refs';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { StaticArtifactStore, staticVersion } from '../../src/transit/gtfs/realtime/snapshot-store';
import { validateItinerary } from '../../src/transit/planner/validator';
import type { Env } from '../../src/types';
import dc from '../fixtures/dc-golden-journeys.json';
import nyc from '../fixtures/nyc-golden-journeys.json';
import { memoryStorage } from '../helpers/realtime-fixture';
import { modernMcpRequest, readMcpResponse } from '../helpers/mcp-request';
import { createMockEnv } from '../setup';
import { sfBayCorpusFixture } from '../helpers/sfbay-corpus';

const corpora = [dc, nyc];
const ref = (corpus: typeof dc | typeof nyc, kind: 'stop' | 'trip' | 'route', id: string) =>
  formatEntityRef({ coverage: corpus.coverage, feed: corpus.feed, kind, id });
async function fixture(corpus: typeof dc | typeof nyc, db = memoryStorage()) {
  const coverage = getCoverage(corpus.coverage);
  expect(coverage, 'coverage must be registered before it can serve shared tools').toBeDefined();
  const compiled = await compileSchedule({ coverage: coverage!, feedId: corpus.feed, files: corpus.files,
    window: { startDate: '20261019', endDate: '20261025' },
    source: { url: corpus.provenance.sourceUrl, retrievedAt: '2026-10-18T00:00:00Z' } });
  await db.bucket.put(compiled.manifest.discoveries[0]!.key, compiled.discoveryBytes);
  await db.bucket.put(compiled.manifest.shards[0]!.key, compiled.shardBytes);
  const version = await new StaticArtifactStore(db.bucket, corpus.coverage).publish(compiled.manifest);
  const env = createMockEnv({ TRANSIT_ARTIFACTS: db.bucket, TRANSIT_COVERAGE_MODES: JSON.stringify({ dc: 'on', nyc: 'on' }) });
  return { db, env, compiled, version, source: { manifest: compiled.manifest, shards: [compiled.shard], now: corpus.now } };
}
async function call(env: Env, name: string, args: Record<string, unknown>) {
  const handler = createMcpHandler(ctx => createMetroMcpServer({ env, era: ctx.era, toolRequest: { name, arguments: args } }));
  try {
    const response = await handler.fetch(await modernMcpRequest('tools/call', { name, arguments: args }));
    expect(response.status).toBe(200);
    const messages = await readMcpResponse(response);
    const envelope = messages[0] as { error?: unknown; result: { isError?: boolean; structuredContent: Record<string, any> } };
    expect(envelope.error).toBeUndefined();
    return envelope.result;
  } finally { await handler.close(); }
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(dc.now)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('DC and NYC synthetic acceptance corpus through the five global tools', () => {
  it.each(corpora)('discovers $coverage with truthful global capabilities', async corpus => {
    const f = await fixture(corpus);
    const output = (await call(f.env, 'find_transit', { query: corpus.coverage })).structuredContent;
    expect(output.coverages).toEqual([expect.objectContaining({ id: corpus.coverage, available: true,
      capabilities: { schedules: true, planning: true, realtimeDepartures: false, alerts: false, vehicles: false, accessibility: false } })]);
    expect(output.sources[0]).toMatchObject({ feedId: corpus.feed, kind: 'gtfs_schedule', scheduleVersion: f.compiled.manifest.sources[0]!.sha256 });
  });

  for (const corpus of corpora) it.each(corpus.journeys)(`${corpus.coverage}: $name`, async journey => {
    const f = await fixture(corpus);
    const result = await call(f.env, 'plan_trip', { coverage: corpus.coverage, origin: { query: journey.origin }, destination: { query: journey.destination },
      departAt: journey.departAt, maxWalkMetres: 200 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.status).toBe('scheduled_only');
    expect(result.structuredContent.itineraries.length).toBeGreaterThan(0);
    for (const raw of result.structuredContent.itineraries) {
      const candidate = itinerarySchema.parse(raw);
      expect(candidate.legs.every(leg => leg.validatorOutcome === 'valid')).toBe(true);
      expect(await validateItinerary(candidate as Parameters<typeof validateItinerary>[0], f.source)).toMatchObject({ valid: true, reasons: [] });
    }
    const itinerary = itinerarySchema.parse(result.structuredContent.itineraries[0]);
    const legs = itinerary.legs.filter(leg => leg.kind === 'transit');
    expect(legs.map(leg => parseTransitRef(leg.tripRef)!.id)).toEqual(journey.want.trips);
    expect(legs.map(leg => leg.headsign)).toEqual(journey.want.headsigns);
    expect(new Date(itinerary.arrivalTime).toISOString()).toBe(journey.want.arrivalTime);
    expect(itinerary.transfers).toBe(journey.want.transfers);
    expect(legs.every(leg => leg.mode === 'subway' && leg.validatorOutcome === 'valid')).toBe(true);
    expect(await validateItinerary(itinerary as Parameters<typeof validateItinerary>[0], f.source)).toMatchObject({ valid: true, reasons: [] });
  });

  it('rejects the wrong-way Shady Grove-bound Red mutation during itinerary recheck', async () => {
    const f = await fixture(dc), journey = dc.journeys[0]!;
    const planned = await call(f.env, 'plan_trip', { coverage: 'Washington DC', origin: { query: journey.origin }, destination: { query: journey.destination }, departAt: journey.departAt, maxWalkMetres: 200 });
    const itinerary = itinerarySchema.parse(planned.structuredContent.itineraries[0]);
    const red = itinerary.legs.find(leg => leg.kind === 'transit')!;
    if (red.kind !== 'transit') throw new Error('missing transit leg');
    red.headsign = 'Shady Grove'; red.directionId = 1;
    const validation = await validateItinerary(itinerary as Parameters<typeof validateItinerary>[0], f.source);
    expect(validation.valid).toBe(false);
    expect(validation.legFailures[0]?.index).toBe(0);
    const recheck = await call(f.env, 'get_service_status', { itinerary });
    expect(recheck.structuredContent.journeyValid).toBe(false);
    expect(recheck.structuredContent.legChecks[0].valid).toBe(false);
    // A real reverse trip still cannot carry the passenger from Dupont to Metro Center.
    red.tripRef = ref(dc, 'trip', 'syn_shady_train');
    red.tripInstanceRef = formatTripInstanceRef({ coverage: 'dc', feed: 'wmata', id: 'syn_shady_train', serviceDate: '20261019', startTime: '08:55:00' });
    red.instanceStartSeconds = 32100;
    red.boardSequence = 3; red.alightSequence = 1;
    expect((await validateItinerary(itinerary as Parameters<typeof validateItinerary>[0], f.source)).valid).toBe(false);
  });

  it.each(corpora)('$coverage keeps scheduled departures and refuses live claims without request-time agency calls', async corpus => {
    const f = await fixture(corpus);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Agency fetch forbidden'));
    const hubFetch = vi.fn().mockRejectedValue(new Error('SF coordinator must not own DC/NYC'));
    f.env.REGION_FEED_HUB = { idFromName: () => 'sf', get: () => ({ fetch: hubFetch }) } as unknown as DurableObjectNamespace;
    const stopId = corpus.coverage === 'dc' ? 'syn_dupont' : 'syn_times';
    const result = await call(f.env, 'get_departures', { stopRef: ref(corpus, 'stop', stopId), at: corpus.now, windowSeconds: 900 });
    expect(result.structuredContent.status).toBe('scheduled_only');
    expect(result.structuredContent.departures).toHaveLength(2);
    expect(result.structuredContent.departures.every((row: { predictedTime: unknown; status: string; tripInstanceRef: string }) =>
      row.predictedTime === null && row.status === 'scheduled_only' && parseTransitRef(row.tripInstanceRef)?.coverage === corpus.coverage)).toBe(true);
    const vehicle = await call(f.env, 'get_vehicle_status', { ref: result.structuredContent.departures[0].tripInstanceRef });
    expect(vehicle.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['REALTIME_UNAVAILABLE'], vehicles: [] });
    const service = await call(f.env, 'get_service_status', { coverage: corpus.coverage });
    expect(service.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['REALTIME_UNAVAILABLE'], alerts: [] });
    const journey = corpus.journeys[0]!;
    const plan = await call(f.env, 'plan_trip', { coverage: corpus.coverage, origin: { query: journey.origin }, destination: { query: journey.destination }, departAt: journey.departAt, maxWalkMetres: 200 });
    expect(plan.structuredContent.status).toBe('scheduled_only');
    expect((await call(f.env, 'find_transit', { query: corpus.coverage })).structuredContent.coverages[0].available).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it('isolates current versions and coordinate discovery across co-resident coverage artifacts', async () => {
    const f = await fixture(dc), n = await fixture(nyc, f.db);
    expect((await new StaticArtifactStore(f.db.bucket, 'dc').current())?.version).toEqual(f.version);
    expect((await new StaticArtifactStore(f.db.bucket, 'nyc').current())?.version).toEqual(n.version);
    const found = await call(f.env, 'find_transit', { latitude: 38.909, longitude: -77.043 });
    expect(found.structuredContent.candidates[0]).toMatchObject({ coverage: 'dc', providerId: 'syn_dupont' });
    const planned = await call(f.env, 'plan_trip', { origin: { latitude: 40.755, longitude: -73.987 }, destination: { query: '28 St' }, departAt: nyc.now, maxWalkMetres: 0 });
    expect(planned.structuredContent.itineraries[0].coverageId).toBe('nyc');
    await expect(new StaticArtifactStore(f.db.bucket, 'dc').publish(n.compiled.manifest)).rejects.toThrow(/coverage/i);
  });

  it('does not attribute DC artifact availability to an explicitly queried unavailable NYC coverage', async () => {
    const f = await fixture(dc);
    f.env.TRANSIT_COVERAGE_MODES = '{"dc":"on","nyc":"off"}';
    const result = await call(f.env, 'find_transit', { query: 'New York', coverage: 'DC' });
    expect(result.structuredContent).toMatchObject({ status: 'unavailable', sources: [], coverages: [{ id: 'nyc', available: false }] });
  });

  it.each(['missing manifest', 'corrupt discovery', 'storage exception'])('preserves the queried NYC attribution after %s despite a DC search scope', async failure => {
    const f = await fixture(dc), n = await fixture(nyc, f.db);
    if (failure === 'missing manifest') await f.db.bucket.delete(`artifacts/nyc/v2/manifests/${n.version.artifactVersion}.json`);
    else if (failure === 'corrupt discovery') await f.db.bucket.put(n.compiled.manifest.discoveries[0]!.key, 'corrupt discovery');
    else vi.spyOn(f.db.bucket, 'get').mockRejectedValue(new Error('Private storage failure'));
    const result = await call(f.env, 'find_transit', { query: 'New York', coverage: 'DC' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      status: 'unavailable', reasons: ['COVERAGE_UNAVAILABLE'], asOf: '2026-10-19T12:59:00.000Z', sources: [],
      attribution: [{ text: 'Transit data provided by the Metropolitan Transportation Authority.', url: 'https://www.mta.info/' }],
      coverages: [], candidates: [], entities: [], clientCoordinates: null,
    });
  });

  it('rejects absent coverage identity instead of hashing its coerced undefined name', async () => {
    const f = await fixture(dc);
    const invalid = { ...f.compiled.manifest, coverageId: undefined } as unknown as typeof f.compiled.manifest;
    await expect(staticVersion(invalid)).rejects.toThrow(/identity/i);
  });

  it.each([undefined, '{}', '{', '[]', 'null', '{"dc":"off"}', '{"dc":"dark"}', '{"dc":"suspended"}', '{"dc":"ON"}', '{"unknown":"on"}', '{"dc":"on","unknown":"on"}', '{"dc":"on","nyc":true}'])('fails closed with modes %s', async mode => {
    const f = await fixture(dc);
    f.env.TRANSIT_COVERAGE_MODES = mode;
    const result = await call(f.env, 'find_transit', { query: 'DC' });
    expect(result.structuredContent.status).toBe('unavailable');
    expect(result.structuredContent.coverages[0].available).toBe(false);
  });

  it('keeps existing SF rollout behavior independent of malformed centralized modes', async () => {
    const f = await sfBayCorpusFixture();
    const env = createMockEnv({ TRANSIT_ARTIFACTS: f.bucket, SFBAY_MODE: 'on', TRANSIT_COVERAGE_MODES: '{' });
    expect((await call(env, 'find_transit', { query: 'SF' })).structuredContent.coverages[0].available).toBe(true);
    env.SFBAY_MODE = 'dark'; env.TRANSIT_COVERAGE_MODES = '{"sfbay":"on","dc":"on"}';
    expect((await call(env, 'find_transit', { query: 'SF' })).structuredContent.coverages[0].available).toBe(false);
  });

  it('refuses global DC/NYC coverage without artifacts even when explicitly enabled', async () => {
    for (const corpus of corpora) {
      const env = createMockEnv({ TRANSIT_COVERAGE_MODES: '{"dc":"on","nyc":"on"}' });
      const result = await call(env, 'plan_trip', { coverage: corpus.coverage, origin: { query: corpus.journeys[0]!.origin }, destination: { query: corpus.journeys[0]!.destination } });
      expect(result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['COVERAGE_UNAVAILABLE'], itineraries: [] });
    }
  });
});
