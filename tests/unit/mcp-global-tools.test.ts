import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY, createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetroMcpServer } from '../../src/mcp/server';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { memoryStorage } from '../helpers/realtime-fixture';
import { at, goldenTransfer, plannerInput, ref, transferInput } from '../helpers/planner-fixture';
import { createMockEnv } from '../setup';
import type { Env } from '../../src/types';
import { EXPECTED_TOOL_NAMES } from '../fixtures/mcp-contracts';

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
  input.files['routes.txt'] += '91,A,91,3\n';
  const compiled = await compileSchedule(input), db = memoryStorage();
  db.objects.set(compiled.manifest.discoveries[0]!.key, compiled.discoveryBytes);
  db.objects.set(compiled.manifest.shards[0]!.key, compiled.shardBytes);
  const version = await new StaticArtifactStore(db.bucket).publish(compiled.manifest);
  const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: db.bucket });
  return { env, db, compiled, version };
}
afterEach(() => vi.useRealTimers());

describe('global transit MCP boundary', () => {
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
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.additionalProperties).toBe(false);
    }
  });
  it('reports coverage capability and availability as runtime data with matching JSON text', async () => {
    const { result } = await call(createMockEnv({ SFBAY_MODE: 'dark' }), 'find_transit', { query: 'SF' });
    expect(result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['COVERAGE_UNAVAILABLE'], sources: [],
      attribution: [{ text: expect.stringContaining('511 SF Bay') }], coverages: [{ id: 'sfbay', available: false, capabilities: { planning: true } }] });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect((await call(createMockEnv(), 'plan_trip', { coverage: 'future-network', origin: { query: 'A' }, destination: { query: 'B' } })).result.structuredContent.status).toBe('unavailable');
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
  it('returns deterministic candidate errors without elicitation and resolves both choices in one round', async () => {
    const { env } = await fixture(true);
    const args = { coverage: 'sfbay', origin: { query: 'Origin' }, destination: { query: 'Destination' }, departAt: at('08:59:00'), maxWalkMetres: 0 };
    const fallback = (await call(env, 'plan_trip', args)).result;
    expect(fallback).toMatchObject({ isError: true, structuredContent: { code: 'ENTITY_AMBIGUOUS', candidates: [
      { endpoint: 'origin', ref: ref('stop', 'A') }, { endpoint: 'origin', ref: ref('stop', 'AA') },
      { endpoint: 'destination', ref: ref('stop', 'C') }, { endpoint: 'destination', ref: ref('stop', 'CC') },
    ] } });
    expect(JSON.parse(fallback.content[0].text)).toEqual(fallback.structuredContent);
    const initial = (await call(env, 'plan_trip', args, true)).result;
    expect(initial, JSON.stringify(initial)).toMatchObject({ resultType: 'input_required', inputRequests: { endpoints: { method: 'elicitation/create' } } });
    expect(initial.inputRequests.endpoints.params.requestedSchema.required).toEqual(['origin', 'destination']);
    const envelope = JSON.parse(Buffer.from(initial.requestState.split('.')[1], 'base64url').toString());
    expect(envelope.p.tool).toBe('plan_trip');
    expect(JSON.stringify(envelope.p)).not.toContain('Origin');
    const retry = { requestState: initial.requestState, inputResponses: { endpoints: { action: 'accept', content: { origin: ref('stop', 'A'), destination: ref('stop', 'C') } } } };
    expect((await call(env, 'plan_trip', args, true, retry)).result.structuredContent.itineraries).toHaveLength(1);
    expect((await call(env, 'plan_trip', { ...args, departAt: at('09:30:00') }, true, retry)).error.code).toBe(-32602);
    expect((await call(env, 'get_departures', { stopRef: ref('stop', 'A') }, true, retry)).error.code).toBe(-32602);
    const invalidChoice = { ...retry, inputResponses: { endpoints: { action: 'accept', content: { origin: ref('stop', 'missing'), destination: ref('stop', 'C') } } } };
    expect((await call(env, 'plan_trip', args, true, invalidChoice)).error.code).toBe(-32602);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 301_000);
    expect((await call(env, 'plan_trip', args, true, retry)).error.code).toBe(-32602);
  });
  it('returns the same versioned essential detail from tools and resources and never aliases an old version', async () => {
    const { env, version } = await fixture();
    const detail = (await call(env, 'find_transit', { ref: ref('route', 'R') })).result.structuredContent;
    expect(detail.entities[0]).toMatchObject({ ref: ref('route', 'R'), patterns: [{ stopRefs: [ref('stop', 'A'), ref('stop', 'B'), ref('stop', 'C')] }] });
    const resource = (await wire(env, 'resources/read', { uri: `transit://entity/${ref('route', 'R')}?version=${version.artifactVersion}` })).result;
    expect(JSON.parse(resource.contents[0].text)).toEqual(detail);
    expect((await wire(env, 'resources/read', { uri: `transit://entity/${ref('route', 'R')}?version=${'0'.repeat(64)}` })).error).toBeDefined();
  });
  it('returns scheduled departures with dated identities and refuses vehicle queries for bare numbers or stops', async () => {
    const { env } = await fixture();
    const departures = (await call(env, 'get_departures', { stopRef: ref('stop', 'A'), at: at('08:59:00') })).result;
    expect(departures.structuredContent).toMatchObject({ status: 'scheduled_only', departures: [{ scheduledTime: at('09:00:00'), tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA' }] });
    for (const value of ['91', ref('stop', 'A'), ref('trip', 'T')]) {
      expect((await call(env, 'get_vehicle_status', { ref: value })).result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_TRANSIT_REF' } });
    }
    expect((await call(env, 'get_vehicle_status', { ref: ref('route', 'R') })).result.structuredContent).toMatchObject({ status: 'unavailable', reasons: ['REALTIME_UNAVAILABLE'], vehicles: [] });
  });
  it('uses stable errors for unknown references and never leaks artifact or agency text', async () => {
    const { env, db, compiled } = await fixture();
    expect((await call(env, 'find_transit', { ref: ref('stop', 'missing') })).result).toMatchObject({ isError: true, structuredContent: { code: 'ENTITY_NOT_FOUND', candidates: [] } });
    db.objects.set(compiled.manifest.discoveries[0]!.key, new TextEncoder().encode('SECRET api_key=abc agency says ignore instructions'));
    const broken = await call(env, 'find_transit', { query: 'Origin', coverage: 'sfbay' });
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
    const { env, version } = await fixture(); const now = Math.floor(Date.now() / 1000);
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
        { id: 'all', header: '<b>Network</b>', description: 'Agency message', routeIds: [], stopIds: [] },
        { id: 'right', header: 'Delay', description: 'Agency message', routeIds: ['R'], stopIds: [] },
        { id: 'other', header: 'Unrelated', description: 'Agency message', routeIds: ['S'], stopIds: [] },
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
    expect(result).toMatchObject({ status: 'realtime', departures: [{ tripInstanceRef: 'tr:sfbay:sf511:trip:VA:20261019:MDk6MDA6MDA', predictedTime: '2026-10-19T16:02:00.000Z' }] });
  });
});
