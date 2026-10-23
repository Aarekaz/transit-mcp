import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY, createMcpHandler } from '@modelcontextprotocol/server';
import { formatInstant } from '../../src/transit/planner/service-day';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { decodeRealtimeFeed } from '../../src/transit/gtfs/realtime/decode';
import { applyTripUpdates } from '../../src/transit/gtfs/realtime/trip-match';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetroMcpServer } from '../../src/mcp/server';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { memoryStorage } from '../helpers/realtime-fixture';
import { at, goldenTransfer, plannerInput, ref, transferInput } from '../helpers/planner-fixture';
import { createMockEnv } from '../setup';
import type { Env } from '../../src/types';
import { EXPECTED_TOOL_NAMES } from '../fixtures/mcp-contracts';
import { complete } from '../../src/mcp/tools/global/shared';

const globals = ['find_transit', 'plan_trip', 'get_departures', 'get_service_status', 'get_vehicle_status'];
async function wire(env: Env, method: string, params: Record<string, unknown>, elicitation = false) {
  const handler = createMcpHandler(ctx => createMetroMcpServer({ env, era: ctx.era,
    toolRequest: typeof params.name === 'string' ? { name: params.name, arguments: params.arguments, inputResponses: params.inputResponses } : undefined }));
  try {
    const response = await handler.fetch(new Request('https://metro.test/mcp', { method: 'POST', headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-method': method,
      'mcp-protocol-version': '2026-07-28', ...(typeof (params.name ?? params.uri) === 'string' ? { 'mcp-name': String(params.name ?? params.uri) } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: elicitation ? { elicitation: { form: {} } } : {},
    } } }) }));
    const body = await response.text();
    return JSON.parse(body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body) as Record<string, any>;
  } finally { await handler.close(); }
}
async function call(env: Env, name: string, args: Record<string, unknown>, elicitation = false, retry: Record<string, unknown> = {}) {
  return wire(env, 'tools/call', { name, arguments: args, ...retry }, elicitation);
}
async function fixture(ambiguous = false, input = plannerInput()) {
  if (ambiguous) input.files['stops.txt'] += 'AA,Origin,37,-122\nCC,Destination,37.04,-122\n';
  input.files['routes.txt'] += input.files['routes.txt'].includes('route_long_name') ? '91,A,91,,3\n' : '91,A,91,3\n';
  const compiled = await compileSchedule(input), db = memoryStorage();
  db.objects.set(compiled.manifest.discoveries[0]!.key, compiled.discoveryBytes);
  db.objects.set(compiled.manifest.shards[0]!.key, compiled.shardBytes);
  const version = await new StaticArtifactStore(db.bucket).publish(compiled.manifest);
  const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: db.bucket });
  return { env, db, compiled, version };
}
async function addOtherFeed(f: Awaited<ReturnType<typeof fixture>>, input = plannerInput()) {
  const other = await compileSchedule({ ...input, feedId: 'other', coverage: { ...input.coverage, feeds: [{ id: 'other', realtime: [] }] } });
  f.db.objects.set(other.manifest.discoveries[0]!.key, other.discoveryBytes); f.db.objects.set(other.manifest.shards[0]!.key, other.shardBytes);
  // Put the other feed first to catch accidental first-provider-ID joins.
  const version = await new StaticArtifactStore(f.db.bucket).publish({ ...f.compiled.manifest,
    sources: [...other.manifest.sources, ...f.compiled.manifest.sources], agencyTimezones: { ...other.manifest.agencyTimezones, ...f.compiled.manifest.agencyTimezones },
    discoveries: [...other.manifest.discoveries, ...f.compiled.manifest.discoveries], shards: [...other.manifest.shards, ...f.compiled.manifest.shards] });
  return version;
}
afterEach(() => vi.useRealTimers());

describe('global transit MCP boundary', () => {
  it.each([[180, 'realtime', null], [181, 'scheduled_only', 'REALTIME_STALE'], [600, 'scheduled_only', 'REALTIME_STALE'], [601, 'scheduled_only', 'REALTIME_UNAVAILABLE']] as const)('honors the Trip Update boundary at %s seconds without inventing predictions', async (age, status, reason) => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const stamp = Date.now() / 1000 - age;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: stamp, receivedAtSeconds: stamp, warnings: [], payload: [{ entityId: 'first', tripId: 'T', stopId: 'A', stopSequence: 1,
        tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', status: 'realtime', departureTimeSeconds: Date.parse(at('09:01:00')) / 1000 }] }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_departures', { stopRef: ref('stop', 'A') })).result.structuredContent;
    expect(result.status).toBe(status); expect(result.departures[0].status).toBe(status);
    expect(result.reasons).toEqual(reason ? [reason] : []);
    expect(result.departures[0].predictedTime).toBe(age <= 180 ? '2026-10-19T09:01:00-07:00' : null);
  });

  it('does not downgrade realtime transit authority for an access walking leg', async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: [{ entityId: 'first', tripId: 'T', stopId: 'A', stopSequence: 1,
        tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', status: 'realtime', departureTimeSeconds: Date.parse(at('09:00:00')) / 1000 }] }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'plan_trip', { origin: { latitude: 36.9999, longitude: -122 }, destination: { ref: ref('stop', 'C') }, maxWalkMetres: 100 })).result.structuredContent;
    expect(result).toMatchObject({ status: 'realtime', itineraries: [{ status: 'realtime', legs: [{ kind: 'walk' }, { kind: 'transit', status: 'realtime' }] }] });
  });
  it('bounds discovery and endpoint ambiguity without silently losing exact alternatives', async () => {
    const input = plannerInput();
    // Each "Crowded" stop is its own place: farther from the next than a short walk.
    for (let index = 0; index < 200; index++) input.files['stops.txt'] += `Large${index},Crowded,${37 + index * 0.004},-122\nFuzzy${index},Fuzzy station ${index},37,-122\n`;
    const f = await fixture(false, input);
    const exact = (await call(f.env, 'find_transit', { query: 'Crowded', limit: 3 })).result.structuredContent;
    expect(exact).toMatchObject({ status: 'unavailable', reasons: ['SCOPE_LIMIT_EXCEEDED'], candidates: [] });
    const fuzzy = (await call(f.env, 'find_transit', { query: 'Fuzzy', limit: 3 })).result.structuredContent;
    expect(fuzzy.candidates).toHaveLength(3);
    const result = (await call(f.env, 'plan_trip', { coverage: 'sfbay', origin: { query: 'Crowded' }, destination: { query: 'Destination' } }, true)).result;
    expect(result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['SCOPE_LIMIT_EXCEEDED'], itineraries: [] });
    expect(result.requestState).toBeUndefined();
  });

  it('makes public instructions and the commute prompt capability-driven with honest legacy lookups', async () => {
    const env = createMockEnv();
    const instructions = (await wire(env, 'server/discover', {})).result.instructions;
    expect(instructions).toMatch(/plan_trip again with routes/);
    expect(instructions).toContain('get_station_predictions'); expect(instructions).toContain('get_incidents');
    expect(instructions).toContain('DC-only'); expect(instructions).toContain('NYC-only'); expect(instructions).toContain('minutesAway');
    const prompt = (await wire(env, 'prompts/get', { name: 'commute-planner', arguments: { city: 'dc', fromStation: 'Dupont', toStation: 'DCA' } })).result.messages[0].content.text;
    expect(prompt).toMatch(/find_transit.*dc/);
    expect(prompt).toMatch(/only if.*available.*planning/i);
    expect(prompt).toContain('get_station_predictions'); expect(prompt).toContain('get_incidents');
    expect(prompt).toContain('do not provide a full journey planner');
    const catalog = (await wire(env, 'tools/list', {})).result.tools;
    // General-purpose agents read the catalog: a refusal must say how to continue.
    expect(catalog.find((tool: any) => tool.name === 'plan_trip').description).toMatch(/routeHints.*routes/);
    expect(catalog.find((tool: any) => tool.name === 'get_departures').description).toMatch(/toStop/);
  });
  it('filters bounded alert periods by the explicit 24-hour scope and itinerary times, with safe identifiers', async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    const definitions: [string, { start?: number; end?: number }[]][] = [
      ['current', [{ start: now - 60, end: now + 60 }]], ['future', [{ start: now + 3600, end: now + 7200 }]],
      ['expired', [{ end: now - 1 }]], ['later', [{ start: now + 86401 }]], ['open-start', [{ end: now + 1800 }]],
      ['open-end', [{ start: now - 60 }]], ['multiple', [{ end: now - 1 }, { start: now + 300, end: now + 1200 }]],
      ['<script>unsafe</script>', []], ['unsafe-selector', []],
    ];
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: definitions.map(([id, activePeriod]) => ({ id, alert: { activePeriod, informedEntity: [{ routeId: id === 'unsafe-selector' ? '<script>R</script>' : 'R' }] } })) }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async (url: string) => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: url.includes('service_alerts') ? payload : [] }) }) } as unknown as DurableObjectNamespace;
    const general = (await call(f.env, 'get_service_status', { coverage: 'sfbay' })).result.structuredContent;
    expect(general.alerts.map((alert: any) => alert.id)).toEqual(['current', 'future', 'open-start', 'open-end', 'multiple']);
    expect(general.alerts.find((alert: any) => alert.id === 'future').activePeriods).toEqual([{ start: formatInstant((now + 3600) * 1000, 'America/Los_Angeles'), end: formatInstant((now + 7200) * 1000, 'America/Los_Angeles') }]);
    expect(general.alerts.find((alert: any) => alert.id === 'open-start').activePeriods[0].start).toBeNull();
    const itinerary = (await call(f.env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, maxWalkMetres: 0 })).result.structuredContent.itineraries[0];
    const recheck = (await call(f.env, 'get_service_status', { itinerary })).result.structuredContent;
    expect(recheck.alerts.map((alert: any) => alert.id)).toEqual(['open-start', 'open-end', 'multiple']);
    expect(JSON.stringify(general)).not.toContain('<script>');
  });

  it.each(['same', 'changed', 'stale', 'mismatch'] as const)('rechecks a realtime journey against the next %s snapshot', async variant => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    let stamp = Date.now() / 1000, delay = 0, version = f.version;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async (url: string) => Response.json({ freshness: 'fresh', status: 'realtime', version,
      producerTimestampSeconds: stamp, receivedAtSeconds: stamp, warnings: [], payload: url.includes('service_alerts') ? [] : [{ entityId: 'first', tripId: 'T', stopId: 'A', stopSequence: 1,
        tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', status: 'realtime', departureTimeSeconds: Date.parse(at('09:00:00')) / 1000 + delay }] }) }) } as unknown as DurableObjectNamespace;
    const itinerary = (await call(f.env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, maxWalkMetres: 0 })).result.structuredContent.itineraries[0];
    vi.setSystemTime(new Date(at('08:59:30')));
    stamp = variant === 'stale' ? Date.now() / 1000 - 181 : Date.now() / 1000;
    if (variant === 'changed') delay = 300;
    if (variant === 'mismatch') version = { ...f.version, artifactVersion: 'a'.repeat(64) };
    const result = (await call(f.env, 'get_service_status', { itinerary })).result.structuredContent;
    // A later train still makes a one-ride journey: the trip holds, at its new time.
    const holds = variant === 'same' || variant === 'changed';
    expect(result.journeyValid).toBe(holds);
    if (holds) expect(result.journeyReasons).toEqual([]);
    else expect(result.journeyReasons).toContain(variant === 'stale' ? 'REALTIME_STALE' : 'SCHEDULE_REALTIME_MISMATCH');
    expect(result.journeyReasons).not.toContain('REALTIME_PROVENANCE');
    if (!holds) {
      expect(result.status).toBe('unavailable');
      expect(result.reasons).toContain(variant === 'stale' ? 'REALTIME_STALE' : 'SCHEDULE_REALTIME_MISMATCH');
    }
  });
  it.each(['stale', 'expired', 'missing', 'mismatch', 'degraded'] as const)('preserves %s realtime diagnostics through departures and planning', async variant => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000, stamp = now - (variant === 'stale' ? 181 : variant === 'expired' ? 601 : 0);
    const version = variant === 'mismatch' ? { ...f.version, artifactVersion: 'a'.repeat(64), sourceVersions: { sf511: 'b'.repeat(64) } } : f.version;
    if (variant !== 'missing') f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: variant === 'stale' ? 'stale' : variant === 'expired' ? 'expired' : 'fresh',
      status: variant === 'stale' || variant === 'expired' ? 'scheduled_only' : 'realtime', version, degraded: variant === 'degraded',
      producerTimestampSeconds: stamp, receivedAtSeconds: stamp, warnings: [], payload: [] }) }) } as unknown as DurableObjectNamespace;
    const reason = variant === 'stale' ? 'REALTIME_STALE' : variant === 'mismatch' ? 'SCHEDULE_REALTIME_MISMATCH' : 'REALTIME_UNAVAILABLE';
    for (const [name, args] of [['get_departures', { stopRef: ref('stop', 'A') }], ['plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, maxWalkMetres: 0 }]] as const) {
      const result = (await call(f.env, name, args)).result.structuredContent;
      expect(result).toMatchObject({ status: 'scheduled_only', reasons: expect.arrayContaining([reason]) });
      if (variant !== 'missing') expect(result.sources).toContainEqual(expect.objectContaining({ kind: 'trip_updates', producerTimestamp: new Date(stamp * 1000).toISOString(), scheduleVersion: version.sourceVersions.sf511 }));
      expect(result.reasons).not.toContain('COVERAGE_UNAVAILABLE');
    }
  });

  it('shows an added train as observed service, without an invented schedule or a blanked board', async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    // As providers publish them: departure-only at the origin, arrival-only at the terminal.
    const decoded = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now }, entity: [{ id: 'extra', tripUpdate: {
      trip: { tripId: 'extra', routeId: 'R', startDate: '20261019', scheduleRelationship: 1 },
      stopTimeUpdate: [{ stopId: 'A', stopSequence: 1, departure: { time: Date.parse(at('09:05:00')) / 1000 } }, { stopId: 'C', stopSequence: 2, arrival: { time: Date.parse(at('09:25:00')) / 1000 } }],
    } }] }).finish());
    const normalized = await applyTripUpdates(decoded, { manifest: f.compiled.manifest, version: f.version, shards: [f.compiled.shard], discoveries: [f.compiled.discovery], feedId: 'sf511' });
    expect(normalized).toMatchObject({ degraded: false, excluded: { unrepresentableAdded: 0 } });
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: normalized.stopUpdates }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_departures', { stopRef: ref('stop', 'A') })).result.structuredContent;
    expect(result.status).toBe('realtime');
    const added = result.departures.find((row: Record<string, unknown>) => row.scheduleMatch === 'unmatched_trip');
    // Identity comes from the observed first call when start_time is absent.
    expect(added).toMatchObject({ tripInstanceRef: 'tr:sfbay:sf511:trip:ZXh0cmE:20261019:MDk6MDU6MDA', scheduledTime: null, stopSequence: null, status: 'realtime',
      predictedTime: formatInstant(new Date(at('09:05:00')).getTime(), 'America/Los_Angeles'), headsign: 'Destination' });
    expect(result.departures.some((row: Record<string, unknown>) => row.scheduleMatch === 'matched')).toBe(true);
    // Planning never uses the observed-only train.
    const plan = (await call(f.env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, maxWalkMetres: 0 })).result.structuredContent;
    expect(plan.itineraries.every((itinerary: { legs: { kind: string; tripRef?: string }[] }) => itinerary.legs.every(leg => leg.kind !== 'transit' || !leg.tripRef!.includes('ZXh0cmE')))).toBe(true);
  });

  it('counts an unrepresentable added train without blanking other predictions', async () => {
    const f = await fixture();
    const decoded = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: 1 }, entity: [{ id: 'extra', tripUpdate: {
      trip: { tripId: 'extra', routeId: 'R', startDate: '20261019', startTime: '09:00:00', scheduleRelationship: 1 },
      stopTimeUpdate: [{ stopId: 'not-a-stop', stopSequence: 1, departure: { time: 1 } }] } }] }).finish());
    const normalized = await applyTripUpdates(decoded, { manifest: f.compiled.manifest, version: f.version, shards: [f.compiled.shard], feedId: 'sf511' });
    expect(normalized).toMatchObject({ degraded: false, stopUpdates: [], excluded: { unrepresentableAdded: 1 } });
  });

  it.each(['DUPLICATED', 'REPLACEMENT', 'REPLACEMENT_NO_DATA'] as const)('explicitly refuses an incomplete departure board for accepted %s service', async relationship => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000, duplicated = relationship === 'DUPLICATED';
    const decoded = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now }, entity: [{ id: 'extra', tripUpdate: {
      trip: { tripId: 'T', routeId: 'R', startDate: '20261019', startTime: '09:00:00', scheduleRelationship: duplicated ? 6 : 5 },
      ...(duplicated ? { tripProperties: { tripId: 'duplicate', startDate: '20261019', startTime: '09:05:00' } } : {}),
      stopTimeUpdate: [{ stopId: 'A', stopSequence: 1, arrival: { time: Date.parse(at('09:05:00')) / 1000 }, departure: { time: Date.parse(at('09:05:00')) / 1000 }, scheduleRelationship: relationship === 'REPLACEMENT_NO_DATA' ? 2 : 0 }],
    } }] }).finish());
    const normalized = await applyTripUpdates(decoded, { manifest: f.compiled.manifest, version: f.version, shards: [f.compiled.shard], discoveries: [f.compiled.discovery], feedId: 'sf511' });
    expect(normalized.degraded).toBe(false); expect(normalized.stopUpdates.length).toBeGreaterThan(0);
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: normalized.stopUpdates }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_departures', { stopRef: ref('stop', 'A') })).result.structuredContent;
    expect(result).toMatchObject({ status: 'unavailable', reasons: ['REALTIME_UNAVAILABLE'], departures: [], frequencyWindows: [] });
    expect(result.sources).toContainEqual(expect.objectContaining({ kind: 'trip_updates', scheduleVersion: f.version.sourceVersions.sf511 }));
    const plan = (await call(f.env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, maxWalkMetres: 0 })).result.structuredContent;
    expect(plan).toMatchObject({ status: 'unavailable', reasons: ['REALTIME_UNAVAILABLE'], itineraries: [] });
  });

  it.each(['NO_DATA', 'CANCELED', 'SKIPPED'] as const)('keeps provable %s static-instance departure semantics', async relationship => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    const decoded = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now }, entity: [{ id: 'update', tripUpdate: {
      trip: { tripId: 'T', startDate: '20261019', scheduleRelationship: relationship === 'CANCELED' ? 3 : 0 }, stopTimeUpdate: [{ stopId: 'A', stopSequence: 1, scheduleRelationship: relationship === 'NO_DATA' ? 2 : 1 }],
    } }] }).finish());
    const normalized = await applyTripUpdates(decoded, { manifest: f.compiled.manifest, version: f.version, shards: [f.compiled.shard], feedId: 'sf511' });
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: normalized.stopUpdates }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_departures', { stopRef: ref('stop', 'A') })).result.structuredContent;
    expect(result.status).toBe('scheduled_only');
    expect(result.departures).toHaveLength(relationship === 'NO_DATA' ? 1 : 0);
    if (relationship === 'NO_DATA') expect(result.departures[0]).toMatchObject({ predictedTime: null, status: 'scheduled_only' });
  });
  it('returns scheduled-only for mixed-authority transit legs through plan_trip', async () => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    const f = await fixture(false, input); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: [{ entityId: 'first', tripId: 'T', stopId: 'A', stopSequence: 1,
        tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', status: 'realtime', departureTimeSeconds: Date.parse(at('09:00:00')) / 1000 }] }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, maxWalkMetres: 0 })).result.structuredContent;
    expect(result).toMatchObject({ status: 'scheduled_only', itineraries: [{ status: 'scheduled_only', legs: [{ status: 'realtime' }, { status: 'scheduled_only' }] }] });
  });
  it.each((['missing-date', 'ambiguous', 'unique'] as const).flatMap(variant => (['trip', 'coverage'] as const).map(target => ({ variant, target }))))('resolves trip-ID-less alert identity only when canonical and unique: $variant / $target', async ({ variant, target }) => {
    const input = plannerInput();
    if (variant === 'ambiguous') {
      input.files['trips.txt'] += 'R,D,U,Destination,0,\n';
      input.files['stop_times.txt'] += 'U,09:00:00,09:00:00,A,1,0,0\nU,09:20:00,09:20:00,C,2,0,0\n';
    }
    const f = await fixture(false, input); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Math.floor(Date.now() / 1000);
    const selector = { trip: { routeId: 'R', directionId: 0, startTime: '09:00:00', ...(variant === 'missing-date' ? {} : { startDate: '20261019' }) } };
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [{ id: 'idless', alert: { informedEntity: [selector] } }] }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_service_status', target === 'coverage' ? { coverage: 'sfbay' } : { ref: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA' })).result.structuredContent;
    expect(result.alerts.map((alert: any) => alert.id)).toEqual(variant === 'unique' ? ['idless'] : []);
    if (variant === 'unique') expect(result.alerts[0].selectors).toEqual([selector]);
  });
  it.each(['route', 'agency', 'stop'] as const)('expands %s status into canonical dated subentities without cross-entity or cross-date matches', async kind => {
    const input = plannerInput();
    input.files['agency.txt'] += 'B,Other,https://example.test,America/Los_Angeles\n';
    input.files['routes.txt'] = input.files['routes.txt'].replace('S,A,S,0', 'S,B,S,0');
    input.files['trips.txt'] += 'S,D,U,Other,1,\n';
    input.files['stop_times.txt'] += 'U,09:00:00,09:00:00,D,1,0,0\nU,09:20:00,09:20:00,C,2,0,0\n';
    const f = await fixture(false, input); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    const cases = [
      { id: 'direction', selector: { routeId: 'R', directionId: 0 } },
      { id: 'trip', selector: { trip: { tripId: 'T', startDate: '20261019', startTime: '09:00:00' } } },
      { id: 'other-direction', selector: { routeId: 'R', directionId: 1 } },
      { id: 'other-entity', selector: { trip: { tripId: 'U', startDate: '20261019', startTime: '09:00:00' } } },
      { id: 'other-date', selector: { trip: { tripId: 'T', startDate: '20261020', startTime: '09:00:00' } } },
      { id: 'mixed-fields', selector: { routeId: 'R', trip: { tripId: 'U', startDate: '20261019' } } },
    ];
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: cases.map(item => ({ id: item.id, alert: { informedEntity: [item.selector] } })) }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload }) }) } as unknown as DurableObjectNamespace;
    const entityRef = kind === 'agency' ? 'tr:sfbay:sf511:agency:QQ' : ref(kind, kind === 'route' ? 'R' : 'B');
    const result = (await call(f.env, 'get_service_status', { ref: entityRef })).result.structuredContent;
    expect(result.alerts.map((alert: any) => alert.id)).toEqual(['direction', 'trip']);
  });
  it('fails closed explicitly when aggregate alert subentity expansion exceeds its bound', async () => {
    const input = plannerInput(); input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,12:00:00,1,1\n';
    const f = await fixture(false, input); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [{ id: 'direction', alert: { informedEntity: [{ routeId: 'R', directionId: 0 }] } }] }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload }) }) } as unknown as DurableObjectNamespace;
    expect((await call(f.env, 'get_service_status', { ref: ref('route', 'R') })).result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['SCOPE_LIMIT_EXCEEDED'], alerts: [] });
  });
  it('retains direction alerts for canonical headway windows without inventing an exact trip instance', async () => {
    const input = plannerInput(); input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,08:00:00,10:00:00,600,0\n';
    const f = await fixture(false, input); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now }, entity: [
      { id: 'direction', alert: { informedEntity: [{ routeId: 'R', directionId: 0 }] } },
      { id: 'unproven-instance', alert: { informedEntity: [{ trip: { tripId: 'T', startDate: '20261019', startTime: '09:00:00' } }] } },
    ] }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_service_status', { ref: ref('route', 'R') })).result.structuredContent;
    expect(result.alerts.map((alert: any) => alert.id)).toEqual(['direction']);
  });
  it('fails closed when the canonical aggregate window is unavailable', async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-10-19T08:59:00-07:00'));
    const now = Date.now() / 1000;
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [{ id: 'direction', alert: { informedEntity: [{ routeId: 'R', directionId: 0 }] } }] }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload }) }) } as unknown as DurableObjectNamespace;
    expect((await call(f.env, 'get_service_status', { ref: ref('route', 'R') })).result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['SCHEDULE_EXPIRED'], alerts: [] });
  });
  it('fails closed when coverage-wide trip-ID-less alert resolution needs an expired schedule window', async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-10-19T08:59:00-07:00'));
    const now = Date.now() / 1000;
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [{ id: 'idless', alert: { informedEntity: [{ trip: { routeId: 'R', directionId: 0, startDate: '20271019', startTime: '09:00:00' } }] } }] }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload }) }) } as unknown as DurableObjectNamespace;
    expect((await call(f.env, 'get_service_status', { coverage: 'sfbay' })).result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['SCHEDULE_EXPIRED'], alerts: [] });
  });
  it.each([{ selectors: [] }, { selectors: [{}] }])('retains network-wide alerts without requiring schedule data: $selectors', async ({ selectors }) => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-10-19T08:59:00-07:00'));
    f.db.objects.delete(f.compiled.manifest.shards[0]!.key);
    const now = Date.now() / 1000;
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [{ id: 'network', alert: { informedEntity: selectors } }] }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_service_status', { coverage: 'sfbay' })).result.structuredContent;
    expect(result).toMatchObject({ status: 'realtime', reasons: [] });
    expect(result.alerts.map((alert: any) => alert.id)).toEqual(['network']);
    expect(result.alerts[0].selectors).toEqual(selectors);
  });
  it.each([
    { name: 'route and wrong trip are a conjunction', selectors: [{ routeId: 'R', trip: { tripId: 'U' } }], wanted: false },
    { name: 'another service date is not the same trip', selectors: [{ trip: { tripId: 'T', startDate: '20261020' } }], wanted: false },
    { name: 'another frequency start is not the same instance', frequency: true, selectors: [{ trip: { tripId: 'T', startDate: '20261019', startTime: '09:10:00' } }], wanted: false },
    { name: 'incomplete frequency identity does not broaden scope', frequency: true, selectors: [{ trip: { tripId: 'T', startDate: '20261019' } }], wanted: false },
    { name: 'full matching dated frequency trip applies', frequency: true, selectors: [{ agencyId: 'A', routeId: 'R', stopId: 'B', trip: { tripId: 'T', startDate: '20261019', startTime: '09:00:00' } }], wanted: true },
    { name: 'wrong agency is not network-wide', selectors: [{ agencyId: 'other' }], wanted: false },
    { name: 'empty trip descriptor is not network-wide', selectors: [{ trip: {} }], wanted: false },
    { name: 'no selectors is network-wide', selectors: [], wanted: true },
    { name: 'separate selectors are alternatives', selectors: [{ routeId: 'S' }, { routeId: 'R', trip: { tripId: 'T', startDate: '20261019' } }], wanted: true },
  ])('matches alert selectors: $name', async ({ frequency, selectors, wanted }) => {
    const input = plannerInput();
    if (frequency) input.files['frequencies.txt'] = 'trip_id,start_time,end_time,headway_secs,exact_times\nT,09:00:00,09:30:00,600,1\n';
    const f = await fixture(false, input), now = Math.floor(Date.now() / 1000);
    const decoded = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now }, entity: [{ id: 'scoped', alert: {
      informedEntity: selectors, headerText: { translation: [{ text: '<b>Delay</b>' }] }, descriptionText: { translation: [{ text: 'Agency notice' }] },
    } }] }).finish());
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: decoded.alerts }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_service_status', { ref: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA' })).result.structuredContent;
    expect(result.alerts.map((alert: any) => alert.id)).toEqual(wanted ? ['scoped'] : []);
    if (wanted) {
      expect(result.alerts[0].agencyText).toEqual({ title: 'Delay', description: 'Agency notice', label: 'agency_supplied' });
      expect(result.alerts[0].selectors).toEqual(selectors.length > 1 ? [selectors[1]] : selectors);
    }
  });
  it('matches an itinerary selector against one canonical leg, never fields collected from different legs', async () => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    const f = await fixture(false, input), now = Math.floor(Date.now() / 1000), itinerary = goldenTransfer(f);
    const selectors = [{ routeId: 'R', trip: { tripId: 'U', startDate: '20261019' } },
      { agencyId: 'A', routeId: 'S', stopId: 'C', trip: { tripId: 'U', startDate: '20261019', startTime: '09:12:00' } }, { routeId: '91' }];
    const payload = decodeRealtimeFeed(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now }, entity: [
      { id: 'mixed', alert: { informedEntity: selectors } }, { id: 'cross-leg-only', alert: { informedEntity: [selectors[0]!] } },
    ] }).finish()).alerts;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async (url: string) => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: url.includes('service_alerts') ? payload : [] }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_service_status', { itinerary: { ...itinerary, legs: itinerary.legs.map((leg, index) => ({ ...leg,
      mode: 'tram', agencyRef: 'tr:sfbay:sf511:agency:QQ', intermediateStopCount: 0, transferRequired: index > 0, sources: [], validatorOutcome: 'valid' })) } })).result.structuredContent;
    expect(result.alerts).toMatchObject([{ id: 'mixed', selectors: [selectors[1]], routeIds: ['S'], stopIds: ['C'] }]);
    expect(result.alerts).toHaveLength(1);
  });
  it('pages past 100 canceled departures before limiting and orders shifted predictions in the query window', async () => {
    const input = plannerInput(), updates: Record<string, unknown>[] = [];
    input.files['trips.txt'] = 'route_id,service_id,trip_id,trip_headsign,direction_id,block_id\n';
    input.files['stop_times.txt'] = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n';
    for (let index = 0; index < 103; index++) {
      const id = `T${String(index).padStart(3, '0')}`, time = `09:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`;
      input.files['trips.txt'] += `R,D,${id},Destination,0,\n`;
      input.files['stop_times.txt'] += `${id},${time},${time},A,1,0,0\n`;
      if (index !== 100) updates.push({ entityId: id, tripId: id, stopId: 'A', stopSequence: 1,
        tripInstanceRef: `${ref('trip', id)}:20261019:${Buffer.from(time).toString('base64url')}`, status: index < 100 ? 'canceled' : 'realtime',
        scheduledDepartureTimeSeconds: Date.parse(at(time)) / 1000, departureTimeSeconds: Date.parse(at(index === 101 ? '09:01:10' : '10:00:00')) / 1000 });
    }
    const f = await fixture(false, input); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: updates }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(f.env, 'get_departures', { stopRef: ref('stop', 'A'), at: at('09:00:00'), windowSeconds: 600, limit: 2 })).result.structuredContent;
    expect(result.departures.map((row: any) => row.tripRef)).toEqual(['tr:sfbay:sf511:trip:VDEwMQ', 'tr:sfbay:sf511:trip:VDEwMA']);
  });
  it('keeps observed route identity and realtime sources in the hub-owned feed namespace', async () => {
    const f = await fixture(), version = await addOtherFeed(f), now = Math.floor(Date.now() / 1000);
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: [{ entityId: 'sf-only', routeId: 'R', latitude: 37, longitude: -122, timestampSeconds: now }] }) }) } as unknown as DurableObjectNamespace;
    const sf = (await call(f.env, 'get_vehicle_status', { ref: ref('route', 'R') })).result.structuredContent;
    expect(sf.vehicles).toMatchObject([{ id: 'sf-only', routeRef: 'tr:sfbay:sf511:route:Ug' }]);
    expect(sf.sources.filter((source: any) => source.kind === 'vehicle_positions').map((source: any) => source.feedId)).toEqual(['sf511']);
    const other = (await call(f.env, 'get_vehicle_status', { ref: 'tr:sfbay:other:route:Ug' })).result.structuredContent;
    expect(other).toMatchObject({ status: 'unavailable', vehicles: [] });
  });
  it('finds stations the way riders type them: abbreviations, word order, filler words and misspellings', async () => {
    const input = plannerInput();
    input.files['stops.txt'] += ['TS,Times Sq-42 St', 'KS,King St-Old Town', 'KM,King St & Marlee Wy', 'W4,W 4 St-Wash Sq', 'LE,L\'Enfant Plaza', 'PM,Powell St & Market St',
      'CC,Crystal City', 'US,Union Station', 'UQ,14 St-Union Sq', 'FB,Fort Totten', 'MC,Metro Center'].map(row => `${row},37.01,-122.01\n`).join('');
    const f = await fixture(false, input);
    const first = async (query: string) => (await call(f.env, 'find_transit', { query, coverage: 'sfbay', limit: 5 })).result.structuredContent.candidates[0]?.name ?? null;
    for (const [query, expected] of [
      ['Times Square station', 'Times Sq-42 St'], ['42nd Street Times Square', 'Times Sq-42 St'], ['times sq 42', 'Times Sq-42 St'], ['Tims Sqare', 'Times Sq-42 St'],
      ['King Street', 'King St-Old Town'], ['West 4th Street', 'W 4 St-Wash Sq'], ['L’Enfant', 'L\'Enfant Plaza'], ['lenfant plaza', 'L\'Enfant Plaza'],
      ['Powell and Market', 'Powell St & Market St'], ['Crystl Cty', 'Crystal City'], ['the metro at crystal city', 'Crystal City'],
      ['Union Station', 'Union Station'], ['union square', '14 St-Union Sq'], ['Ft Totten', 'Fort Totten'], ['metro center', 'Metro Center'],
    ] as const) expect(await first(query), query).toBe(expected);
    // Folding and typo tolerance must not invent matches.
    for (const query of ['Brooklyn Bridge', 'Penn Station', 'zzz']) expect(await first(query), query).toBeNull();
    // A name the timetable spells differently gets suggestions, never a match.
    const official = (await call(f.env, 'find_transit', { query: 'Gallery Pl-Chinatown Station', coverage: 'sfbay' })).result.structuredContent;
    expect(official.candidates).toEqual([]);
    const near = (await call(f.env, 'find_transit', { query: 'Crystal Cityy Metro', coverage: 'sfbay' })).result.structuredContent;
    expect(near.candidates.length + (near.suggestions?.length ?? 0)).toBeGreaterThan(0);
    const missing = await call(f.env, 'get_departures', { stop: 'Metro Centre Station Plaza', coverage: 'sfbay' });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent).toMatchObject({ code: 'ENTITY_NOT_FOUND', message: expect.stringContaining('closest names, not matches') });
    expect(missing.result.structuredContent.candidates[0]).toMatchObject({ name: 'Metro Center' });
    expect((await call(f.env, 'find_transit', { query: 'qqqq xxxx', coverage: 'sfbay' })).result.structuredContent.suggestions ?? []).toEqual([]);
  });
  it('preserves exact public route-number alternatives even when provider IDs and long names differ', async () => {
    const input = plannerInput(); input.files['routes.txt'] = 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,A,91,Night Service,3\n';
    const f = await fixture(false, input), other = plannerInput();
    other.files['routes.txt'] = 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,A,91,Crosstown,3\n';
    await addOtherFeed(f, other);
    const result = (await call(f.env, 'find_transit', { query: ' 91 ', context: { feed: 'other' }, limit: 1 })).result.structuredContent;
    expect(result.candidates.map((candidate: any) => candidate.ref)).toEqual(['tr:sfbay:other:route:Ug', 'tr:sfbay:sf511:route:OTE', 'tr:sfbay:sf511:route:Ug']);
  });
  it('advertises flat input schemas, with selector exclusivity checked by the tool', async () => {
    const env = createMockEnv(), { result } = await wire(env, 'tools/list', {}), validator = new AjvJsonSchemaValidator();
    for (const [name, valid, invalid, combined] of [
      // No selector lists the regions served.
      ['find_transit', [{}, { coverage: 'dc' }, { query: '91' }, { ref: ref('stop', 'A') }, { latitude: 37, longitude: -122 }], [{ query: '91', extra: true }], [{ ref: 'x', query: '91' }, { latitude: 37 }]],
      // coverage is a closed list: region ids and their own names, nothing else.
      ['get_service_status', [{ ref: ref('route', 'R') }, { ref: ref('route', 'R'), coverage: 'sfbay' }, { coverage: 'sfbay' }, { coverage: 'Washington DC' }], [{ coverage: 'sfbay', extra: true }, { coverage: 'Mars' }], [{}, { ref: ref('route', 'R'), coverage: 'dc' }, { stop: 'Fulton St' }]],
    ] as const) {
      const schema = result.tools.find((tool: any) => tool.name === name).inputSchema;
      // Clients flatten a top-level union, often to one branch; a forbidden property hides it from the model.
      expect(schema.type).toBe('object'); expect(schema.anyOf).toBeUndefined();
      for (const property of Object.values<any>(schema.properties)) expect(property.not).toBeUndefined();
      const check = validator.getValidator(schema);
      for (const args of valid) expect(check(args).valid, `${name}: ${JSON.stringify(args)}`).toBe(true);
      for (const args of invalid) expect(check(args).valid, `${name}: ${JSON.stringify(args)}`).toBe(false);
      for (const args of combined) expect((await call(env, name, args)).result, `${name}: ${JSON.stringify(args)}`).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_ARGUMENTS' } });
    }
  });
  it.each(['trip', 'itinerary'] as const)('limits %s alerts to authoritative route and stop scope plus network alerts', async selector => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    const f = await fixture(false, input), now = Math.floor(Date.now() / 1000);
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async (url: string) => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: url.includes('service_alerts') ? [
        { id: 'network', header: '', description: '', routeIds: [], stopIds: [], selectors: [] },
        { id: 'first-route', header: '', description: '', routeIds: ['R'], stopIds: [], selectors: [{ routeId: 'R' }] },
        { id: 'second-route', header: '', description: '', routeIds: ['S'], stopIds: [], selectors: [{ routeId: 'S' }] },
        { id: 'interchange', header: '', description: '', routeIds: [], stopIds: ['B'], selectors: [{ stopId: 'B' }] },
        { id: 'first-trip', header: '', description: '', routeIds: [], stopIds: [], tripIds: ['T'], selectors: [{ trip: { tripId: 'T' } }] },
        { id: 'other-trip', header: '', description: '', routeIds: [], stopIds: [], tripIds: ['unrelated'], selectors: [{ trip: { tripId: 'unrelated' } }] },
        { id: 'other-route', header: '', description: '', routeIds: ['91'], stopIds: [], selectors: [{ routeId: '91' }] },
        { id: 'other-stop', header: '', description: '', routeIds: [], stopIds: ['D'], selectors: [{ stopId: 'D' }] },
      ] : [] }) }) } as unknown as DurableObjectNamespace;
    const itinerary = goldenTransfer(f);
    const args = selector === 'trip' ? { ref: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA' } : { itinerary: { ...itinerary,
      legs: itinerary.legs.map((leg, index) => ({ ...leg, mode: 'tram', agencyRef: 'tr:sfbay:sf511:agency:QQ', intermediateStopCount: 0, transferRequired: index > 0, sources: [], validatorOutcome: 'valid' })) } };
    const result = (await call(f.env, 'get_service_status', args)).result.structuredContent;
    expect(result.alerts.map((alert: any) => alert.id)).toEqual(selector === 'trip' ? ['network', 'first-route', 'interchange', 'first-trip'] : ['network', 'first-route', 'second-route', 'interchange', 'first-trip']);
  });
  it.each(['canceled', 'skipped', 'transfer'] as const)('revalidates only the affected %s leg or boundary without creating alternatives', async failure => {
    const input = transferInput(); input.files['trips.txt'] = input.files['trips.txt'].replaceAll(',block', ',');
    if (failure === 'transfer') input.files['transfers.txt'] = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,B,2,180\n';
    const f = await fixture(false, input); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const now = Date.now() / 1000;
    f.env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async (url: string) => Response.json({ freshness: 'fresh', status: 'realtime', version: f.version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: url.includes('trip_updates') && failure !== 'transfer'
        ? [{ entityId: 'second', stopId: 'B', stopSequence: 1, tripInstanceRef: 'tr:sfbay:sf511:trip:VQ:20261019:MDk6MTI6MDA', status: failure }] : [] }) }) } as unknown as DurableObjectNamespace;
    const itinerary = goldenTransfer(f);
    const result = (await call(f.env, 'get_service_status', { itinerary: { ...itinerary, legs: itinerary.legs.map((leg, index) => ({ ...leg,
      mode: 'tram', agencyRef: 'tr:sfbay:sf511:agency:QQ', intermediateStopCount: 0, transferRequired: index > 0, sources: [], validatorOutcome: 'valid' })) } })).result.structuredContent;
    expect(result).toMatchObject({ journeyValid: false, legChecks: [{ index: 0, valid: true, reasons: [] },
      { index: 1, valid: failure === 'transfer', reasons: failure === 'transfer' ? [] : [failure === 'canceled' ? 'TRIP_CANCELED' : 'STOP_SKIPPED'] }],
      transferChecks: failure === 'transfer' ? [{ fromLegIndex: 0, toLegIndex: 1, valid: false, reasons: ['TRANSFER_MINIMUM'] }] : [] });
    expect(result.itineraries).toBeUndefined();
    expect(result.sources).toContainEqual(expect.objectContaining({ kind: 'trip_updates', producerTimestamp: '2026-10-19T15:59:00.000Z' }));
  });
  it.each(['off', 'dark', 'on'] as const)('keeps five global tools registered in %s mode without advertising the legacy app', async mode => {
    const { result } = await wire(createMockEnv({ SFBAY_MODE: mode }), 'tools/list', {});
    expect(result.tools.map((tool: any) => tool.name)).toEqual([...EXPECTED_TOOL_NAMES, ...globals]);
    for (const tool of result.tools.slice(13)) {
      expect(tool.title).toBeTruthy(); expect(tool.description.length).toBeGreaterThan(50);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      expect(tool._meta).toBeUndefined();
      for (const branch of tool.inputSchema.anyOf ?? [tool.inputSchema]) expect(branch.additionalProperties).toBe(false);
      expect(tool.outputSchema.additionalProperties).toBe(false);
    }
  });
  it('reports coverage capability and availability as runtime data with matching JSON text', async () => {
    const { result } = await call(createMockEnv({ SFBAY_MODE: 'dark' }), 'find_transit', { query: 'SF' });
    expect(result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['COVERAGE_UNAVAILABLE'], sources: [],
      attribution: [{ text: expect.stringContaining('511 SF Bay') }], coverages: [{ id: 'sfbay', available: false, capabilities: { planning: true } }] });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    // An unknown region is refused with the list of real ones, so the model can correct it.
    const unknown = (await call(createMockEnv(), 'plan_trip', { coverage: 'future-network', origin: { query: 'A' }, destination: { query: 'B' } })).result;
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain('Use one of: sfbay, dc, nyc');
  });
  it('plans named endpoints in one call, defaults to now and exposes verified legs with provenance', async () => {
    const { env } = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('08:59:00')));
    const { result, error } = await call(env, 'plan_trip', { coverage: 'sfbay', origin: { query: 'Origin' }, destination: { query: 'Destination' }, maxWalkMetres: 0 });
    expect(error).toBeUndefined();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'scheduled_only', asOf: '2026-10-19T15:59:00.000Z',
      sources: [{ feedId: 'sf511', kind: 'gtfs_schedule', scheduleVersion: expect.any(String) }],
      itineraries: [{ arrivalTime: at('09:20:00'), legs: [{ kind: 'transit', mode: 'tram', agencyRef: 'tr:sfbay:sf511:agency:QQ', intermediateStopCount: 1, validatorOutcome: 'valid' }] }] });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
  it.each([{ origin: { ref: ref('stop', 'A'), query: 'Origin' } }, { origin: { latitude: 37 } }, { origin: { latitude: 91, longitude: -122 } }, { typo: true }])('rejects malformed or extra endpoint input %j', async extra => {
    const { env } = await fixture();
    const value = await call(env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, ...extra });
    expect(value.error ?? value.result?.isError).toBeTruthy();
  });
  it('withholds planning for a coverage the deployment lists, keeping its other tools', async () => {
    const { env } = await fixture();
    const plan = async (planningOff?: string) => (await call({ ...env, ...(planningOff ? { TRANSIT_PLANNING_OFF: planningOff } : {}) } as typeof env, 'plan_trip',
      { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, departAt: at('08:59:00') })).result.structuredContent;
    expect(await plan('["sfbay"]')).toMatchObject({ status: 'unavailable', reasons: ['PLANNING_UNAVAILABLE'], itineraries: [] });
    expect((await plan()).reasons).not.toContain('PLANNING_UNAVAILABLE');
    const found = (await call({ ...env, TRANSIT_PLANNING_OFF: '["sfbay"]' } as typeof env, 'find_transit', { query: 'sfbay' })).result.structuredContent;
    expect(found.coverages[0].capabilities).toMatchObject({ planning: false, schedules: true });
    // Malformed configuration withholds planning everywhere rather than guessing.
    expect(await plan('not json')).toMatchObject({ reasons: ['PLANNING_UNAVAILABLE'] });
  });
  it('plans a name standing for one place from all its stops, and never asks the user to pick stop IDs', async () => {
    // Two stops named "Origin" at one spot, and two "Destination"s: one place each.
    const { env } = await fixture(true);
    const args = { coverage: 'sfbay', origin: { query: 'Origin' }, destination: { query: 'Destination' }, departAt: at('08:59:00'), maxWalkMetres: 0 };
    for (const elicitation of [false, true]) {
      const result = (await call(env, 'plan_trip', args, elicitation)).result;
      expect(result.isError).toBeUndefined(); expect(result.resultType).not.toBe('input_required'); expect(result.requestState).toBeUndefined();
      expect(result.structuredContent.itineraries).toHaveLength(1);
      expect(result.structuredContent.notice).toBeUndefined(); expect(result.structuredContent.itineraries[0].reading).toBeUndefined();
    }
    expect((await call(env, 'get_departures', { stop: 'Origin', coverage: 'sfbay', at: at('08:59:00') })).result.structuredContent.departures).toHaveLength(1);
  });
  it('puts the answer first and cites each source once, schedules only for feeds it names', () => {
    const schedule = (feedId: string) => ({ feedId, kind: 'gtfs_schedule', producerTimestamp: null, ingestedAt: '2026-10-22T00:00:00.000Z', ageSeconds: null, scheduleVersion: feedId });
    const live = { ...schedule('subway'), kind: 'trip_updates', ageSeconds: 5 };
    const result = complete({ asOf: '2026-10-22T00:00:00.000Z', sources: [schedule('subway'), schedule('bus'), schedule('rail'), live, live], attribution: [], status: 'realtime',
      itineraries: [{ steps: [], legs: [{ tripRef: 'tr:nyc:subway:trip:MQ', sources: [schedule('subway'), live, live] }] }] }).structuredContent as any;
    expect(Object.keys(result)).toEqual(['asOf', 'status', 'itineraries', 'sources', 'attribution']);
    expect(result.sources).toEqual([schedule('subway'), live]);
    expect(result.itineraries[0].legs[0].sources).toEqual([schedule('subway'), live]);
    // Naming no feed, a result keeps every schedule it was answered from.
    expect(complete({ asOf: '', sources: [schedule('bus'), schedule('rail')], attribution: [], status: 'unavailable' }).structuredContent.sources).toHaveLength(2);
  });
  it('names a walk between two same-named stations by their lines, in local time', async () => {
    // Two stations named "Origin" 300 m apart, like 34 St-Penn Station for the A and for the 1.
    const input = plannerInput();
    input.files['stops.txt'] += 'Y,Origin,37.0027,-122\n';
    input.files['trips.txt'] += 'S,D,U,Destination,0,\n';
    input.files['stop_times.txt'] += 'U,09:10:00,09:10:00,Y,1,0,0\nU,09:25:00,09:25:00,C,2,0,0\n';
    const { env } = await fixture(false, input);
    const result = (await call(env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, departAt: at('09:01:00'), maxWalkMetres: 800 })).result.structuredContent;
    const itinerary = result.itineraries[0];
    expect(itinerary.steps[0]).toMatchObject({ kind: 'walk', fromName: 'Origin (R)', toName: 'Origin (S)' });
    // The rider's view leads; the exact legs for rechecking follow.
    expect(Object.keys(itinerary).slice(0, 6)).toEqual(['departureTime', 'arrivalTime', 'status', 'transfers', 'walkingMetres', 'steps']);
    // One clock throughout: the agency's, walks included.
    for (const time of [itinerary.departureTime, itinerary.arrivalTime, ...itinerary.legs.flatMap((leg: any) => [leg.departureTime, leg.arrivalTime])]) expect(time).toMatch(/-07:00$/);
  });
  it('reads a name a station and street corners share as the station, its corners included, unless a corner is named in full', async () => {
    // A rail station, a bus stop at its door, and a bus stop on a far street named for it.
    const input = plannerInput();
    input.files['stops.txt'] += 'X,Bay Point,37.1,-122\nNEAR,Bay Point Rd & 1st St,37.1005,-122\nFAR,Elm St & Bay Point Rd,37.3,-122\n';
    input.files['routes.txt'] += 'Q,A,Q,2\nBUS,A,9,3\n';
    input.files['trips.txt'] += 'Q,D,QT,Bay Point,0,\nBUS,D,BT,Elm St,0,\n';
    input.files['stop_times.txt'] += 'QT,09:00:00,09:00:00,C,1,0,0\nQT,09:20:00,09:20:00,X,2,0,0\nBT,09:00:00,09:00:00,NEAR,1,0,0\nBT,09:30:00,09:30:00,FAR,2,0,0\n';
    const { env } = await fixture(false, input);
    const board = (await call(env, 'get_departures', { stop: 'Bay', coverage: 'sfbay', at: at('08:59:00') })).result.structuredContent;
    expect(board.code).toBeUndefined();
    expect(new Set(board.departures.map((row: any) => row.stopName))).toEqual(new Set(['Bay Point', 'Bay Point Rd & 1st St']));
    const corner = (await call(env, 'get_departures', { stop: 'Elm St & Bay Point Rd', coverage: 'sfbay', at: at('09:00:00') })).result.structuredContent;
    expect(corner.code).toBeUndefined();
    expect(corner.departures.every((row: any) => row.stopName === 'Elm St & Bay Point Rd')).toBe(true);
  });
  it('finds a name a rider gives with its operator ("Ashby BART station") among that operator\'s stops', async () => {
    const input = plannerInput();
    input.files['agency.txt'] += 'BA,BART,https://bart.gov,America/Los_Angeles\n';
    input.files['stops.txt'] += 'X,Ashby,37.1,-122\nY,Ashby Ave & Adeline St,37.3,-122\n';
    input.files['routes.txt'] += 'Q,BA,Red,1\nBUS,A,9,3\n';
    input.files['trips.txt'] += 'Q,D,QT,Ashby,0,\nBUS,D,BT,Adeline,0,\n';
    input.files['stop_times.txt'] += 'QT,09:00:00,09:00:00,X,1,0,0\nQT,09:20:00,09:20:00,C,2,0,0\nBT,09:00:00,09:00:00,Y,1,0,0\nBT,09:30:00,09:30:00,C,2,0,0\n';
    const { env } = await fixture(false, input);
    const board = (await call(env, 'get_departures', { stop: 'Ashby BART station', coverage: 'sfbay', at: at('08:59:00') })).result.structuredContent;
    expect(board.code).toBeUndefined();
    expect(board.departures.map((row: any) => row.stopName)).toEqual(['Ashby']);
  });
  it('takes a line by name for its status, and more walking than a journey allows as the most it allows', async () => {
    const { env } = await fixture(false);
    const status = (await call(env, 'get_service_status', { coverage: 'sfbay', ref: 'R line' })).result;
    expect(status.isError).toBeUndefined();
    expect((await call(env, 'get_service_status', { coverage: 'sfbay', ref: 'Nope' })).result.structuredContent.code).toBe('ENTITY_NOT_FOUND');
    const plan = (await call(env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, departAt: at('08:59:00'), maxWalkMetres: 1200 })).result;
    expect(plan.isError).toBeUndefined();
    expect(plan.structuredContent.itineraries[0].maxWalkMetres).toBe(800);
  });
  it('plans each place a name means, labelled, and asks a question a rider can answer elsewhere', async () => {
    const input = plannerInput(); input.files['stops.txt'] += 'FAR,Origin,37.5,-122\n';
    const { env } = await fixture(false, input);
    const result = (await call(env, 'plan_trip', { coverage: 'sfbay', origin: { query: 'Origin' }, destination: { query: 'Destination' }, departAt: at('08:59:00'), maxWalkMetres: 0 }, true)).result;
    expect(result.isError).toBeUndefined(); expect(result.requestState).toBeUndefined();
    // The far "Origin" has no service: only the reading with a trip is returned, and the notice names both.
    expect(result.structuredContent.notice).toMatch(/^"Origin" is 2 different places \(Origin \(.+\); Origin\)\. The best trip for each reading follows/);
    expect(result.structuredContent.itineraries).toHaveLength(1);
    expect(result.structuredContent.itineraries[0]).toMatchObject({ origin: ref('stop', 'A'), reading: { origin: 'Origin (R tram)', destination: 'Destination (R tram)' } });
    const board = (await call(env, 'get_departures', { stop: 'Origin', coverage: 'sfbay' })).result;
    expect(board).toMatchObject({ isError: true, structuredContent: { code: 'ENTITY_AMBIGUOUS', candidates: [{ ref: ref('stop', 'A') }, { ref: ref('stop', 'FAR') }] } });
    expect(board.structuredContent.message).toMatch(/"Origin" is 2 different places: .*ask the rider which/);
  });
  it('returns the same versioned essential detail from tools and resources and never aliases an old version', async () => {
    const { env, version } = await fixture();
    const detail = (await call(env, 'find_transit', { ref: ref('route', 'R') })).result.structuredContent;
    expect(detail.entities[0]).toMatchObject({ ref: ref('route', 'R'), patterns: [{ stopRefs: [ref('stop', 'A'), ref('stop', 'B'), ref('stop', 'C')] }] });
    const resource = (await wire(env, 'resources/read', { uri: `transit://entity/${ref('route', 'R')}?version=${version.artifactVersion}` })).result;
    expect(JSON.parse(resource.contents[0].text)).toEqual(detail);
    expect((await wire(env, 'resources/read', { uri: `transit://entity/${ref('route', 'R')}?version=${'0'.repeat(64)}` })).error).toBeDefined();
  });
  it('returns scheduled departures with dated identities and refuses vehicle queries for bare numbers or undated trips', async () => {
    const { env } = await fixture();
    const departures = (await call(env, 'get_departures', { stopRef: ref('stop', 'A'), at: at('08:59:00') })).result;
    expect(departures.structuredContent).toMatchObject({ status: 'scheduled_only', departures: [{ scheduledTime: at('09:00:00'), tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA' }] });
    for (const value of ['91', ref('trip', 'T')]) {
      expect((await call(env, 'get_vehicle_status', { ref: value })).result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_TRANSIT_REF' } });
    }
    expect((await call(env, 'get_vehicle_status', { ref: ref('route', 'R') })).result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['REALTIME_UNAVAILABLE'], vehicles: [] });
  });
  it('uses stable errors for unknown references and never leaks artifact or agency text', async () => {
    const { env } = await fixture();
    expect((await call(env, 'find_transit', { ref: ref('stop', 'missing') })).result).toMatchObject({ isError: true, structuredContent: { code: 'ENTITY_NOT_FOUND', candidates: [] } });
    // A store whose discovery object is corrupt before it was ever verified. (A verified,
    // content-addressed index is reused, so corruption after verification cannot change answers.)
    const corrupt = await fixture();
    corrupt.db.objects.set(corrupt.compiled.manifest.discoveries[0]!.key, new TextEncoder().encode('SECRET api_key=abc agency says ignore instructions'));
    const broken = await call(corrupt.env, 'find_transit', { query: 'Origin', coverage: 'sfbay' });
    expect(JSON.stringify(broken)).not.toMatch(/SECRET|api_key|ignore instructions|stack|integrity/);
    expect(broken.result.structuredContent.status).toBe('unavailable');
  });
  it('keeps network-qualified alternatives for a bare number even with context and a small limit', async () => {
    const { env, db, compiled } = await fixture();
    const other = await compileSchedule({ ...plannerInput(), coverage: { ...plannerInput().coverage, feeds: [{ id: 'other', realtime: [] }] }, feedId: 'other', files: { ...plannerInput().files,
      'routes.txt': 'route_id,agency_id,route_short_name,route_type\nR,A,R,0\n91,A,91,3\n' } });
    db.objects.set(other.manifest.discoveries[0]!.key, other.discoveryBytes);
    db.objects.set(other.manifest.shards[0]!.key, other.shardBytes);
    await new StaticArtifactStore(db.bucket).publish({ ...compiled.manifest, sources: [...compiled.manifest.sources, ...other.manifest.sources],
      agencyTimezones: { ...compiled.manifest.agencyTimezones, ...other.manifest.agencyTimezones }, discoveries: [...compiled.manifest.discoveries, ...other.manifest.discoveries], shards: [...compiled.manifest.shards, ...other.manifest.shards] });
    const { result } = await call(env, 'find_transit', { query: '91', context: { coverage: 'sfbay', feed: 'other' }, limit: 1 });
    expect(result.structuredContent.candidates.map((candidate: any) => candidate.ref)).toEqual(['tr:sfbay:other:route:OTE', 'tr:sfbay:sf511:route:OTE']);
  });
  it('returns only authoritative dated-trip and route observations, preserving missing trip identity', async () => {
    // A frozen clock: ages are exact even when a call crosses a second boundary.
    const { env, version } = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('09:02:00')));
    const now = Math.floor(Date.now() / 1000);
    env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: [
        { entityId: 'dated', routeId: 'R', tripId: 'T', tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', latitude: 37, longitude: -122, timestampSeconds: now - 3 },
        { entityId: 'bare', routeId: 'R', tripId: 'T', latitude: 37, longitude: -122, timestampSeconds: now - 3 },
        { entityId: 'old', routeId: 'R', tripId: 'T', latitude: 37, longitude: -122, timestampSeconds: now - 400 },
      ] }) }) } as unknown as DurableObjectNamespace;
    const dated = (await call(env, 'get_vehicle_status', { ref: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA' })).result;
    expect(dated.structuredContent).toMatchObject({ status: 'realtime', vehicles: [{ id: 'dated', ageSeconds: 3 }] });
    expect((await call(env, 'get_vehicle_status', { ref: ref('route', 'R') })).result.structuredContent.vehicles.map((row: any) => row.id)).toEqual(['dated', 'bare']);
    expect((await call(env, 'get_vehicle_status', { ref: 'tr:sfbay:sf511:trip:VA:20261020:MDk6MDA6MDA' })).result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['REALTIME_UNAVAILABLE'], vehicles: [] });
  });
  it('labels agency text and retains global alerts while excluding unrelated route alerts', async () => {
    const { env, version } = await fixture(); const now = Math.floor(Date.now() / 1000);
    env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'stale', status: 'realtime', version,
      producerTimestampSeconds: now - 1300, receivedAtSeconds: now - 1299, warnings: [], payload: [
        { id: 'all', header: '<b>Network</b>', description: 'Agency message', routeIds: [], stopIds: [], selectors: [] },
        { id: 'right', header: 'Delay', description: 'Agency message', routeIds: ['R'], stopIds: [], selectors: [{ routeId: 'R' }] },
        { id: 'other', header: 'Unrelated', description: 'Agency message', routeIds: ['S'], stopIds: [], selectors: [{ routeId: 'S' }] },
      ] }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(env, 'get_service_status', { ref: ref('route', 'R') })).result.structuredContent;
    expect(result.alerts).toMatchObject([{ id: 'all', agencyText: { title: 'Network', label: 'agency_supplied' }, stale: true }, { id: 'right', stale: true }]);
    const source = result.sources.find((source: any) => source.kind === 'alerts');
    expect(source.ageSeconds).toBeGreaterThanOrEqual(1300);
    expect(source.ageSeconds).toBeLessThan(1302);
  });
  it('counts intermediate stops from canonical calls even when sequence numbers have gaps', async () => {
    const input = plannerInput(); input.files['stop_times.txt'] = input.files['stop_times.txt'].replace('A,1,', 'A,10,').replace('B,2,', 'B,20,').replace('C,3,', 'C,30,');
    const compiled = await compileSchedule(input), db = memoryStorage();
    db.objects.set(compiled.manifest.discoveries[0]!.key, compiled.discoveryBytes); db.objects.set(compiled.manifest.shards[0]!.key, compiled.shardBytes);
    await new StaticArtifactStore(db.bucket).publish(compiled.manifest);
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: db.bucket });
    const result = (await call(env, 'plan_trip', { origin: { ref: ref('stop', 'A') }, destination: { ref: ref('stop', 'C') }, departAt: at('08:59:00'), maxWalkMetres: 0 })).result;
    expect(result.structuredContent.itineraries[0].legs[0].intermediateStopCount).toBe(1);
  });
  it('uses the stable caller-error envelope for an out-of-range departure window', async () => {
    const { env } = await fixture();
    const { result } = await call(env, 'get_departures', { stopRef: ref('stop', 'A'), windowSeconds: 604801 });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'TIME_OUTSIDE_WINDOW', candidates: [] } });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
  it('includes a delayed departure after its scheduled window and preserves its authoritative trip identity', async () => {
    const { env, version } = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at('09:01:00')));
    const now = Date.now() / 1000;
    env.REGION_FEED_HUB = { idFromName: () => 'hub', get: () => ({ fetch: async () => Response.json({ freshness: 'fresh', status: 'realtime', version,
      producerTimestampSeconds: now, receivedAtSeconds: now, warnings: [], payload: [{ entityId: 'delayed', stopId: 'A', stopSequence: 1, tripId: 'T', routeId: 'R',
        tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', scheduledDepartureTimeSeconds: Date.parse(at('09:00:00')) / 1000,
        departureTimeSeconds: Date.parse(at('09:02:00')) / 1000, status: 'realtime' }] }) }) } as unknown as DurableObjectNamespace;
    const result = (await call(env, 'get_departures', { stopRef: ref('stop', 'A'), limit: 1 })).result.structuredContent;
    expect(result).toMatchObject({ status: 'realtime', departures: [{ tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', predictedTime: '2026-10-19T09:02:00-07:00' }] });
  });
});
