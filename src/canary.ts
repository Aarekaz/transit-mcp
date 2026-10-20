import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { loadConfig } from './config';
import { handleMcpRequest } from './mcp/http-handler';
import { getCoverageMode } from './regions/manifest';
import { formatEntityRef } from './transit/core/refs';
import type { Env } from './types';

/** A production self-check: the same tool calls an agent makes, through the real MCP
 * handler, judged on what a rider would get. Run every other day; read at /health/deep. */
export interface CanaryCheck { name: string; ok: boolean; ms: number; detail: string }
export interface CanaryReport { at: string; ok: boolean; checks: CanaryCheck[] }
interface CanaryState { latest: CanaryReport; history: { at: string; ok: boolean; failed: string[] }[] }

export const CANARY_KEY = 'health/canary.json';
/** A check slower than this fails: a rider would have given up. */
const SLOW_MS = 30_000;
/** Runs every other day at 14:00 UTC (10:00 in New York, 07:00 in San Francisco). */
export function canaryDue(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return Math.floor(scheduledTime / 86_400_000) % 2 === 0 && at.getUTCHours() === 14 && at.getUTCMinutes() < 5;
}
/** A report older than this means the check itself stopped running (two days and a margin). */
export const CANARY_STALE_SECONDS = 50 * 3600;
const HISTORY = 96;

type Structured = Record<string, any>;
async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: Structured }> {
  const origin = new URL(loadConfig(env).mcp.publicOrigin);
  const request = new Request(new URL('/mcp', origin), {
    method: 'POST',
    headers: { host: origin.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_INFO_META_KEY]: { name: 'transit-canary', version: '1.0.0' }, [CLIENT_CAPABILITIES_META_KEY]: {} } } }),
  });
  const response = await handleMcpRequest(request, env);
  const text = await response.text();
  const messages = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n\r?\n/).flatMap(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim())))
    : text ? [JSON.parse(text)] : [];
  const envelope = messages[0] as { error?: { message?: string }; result?: { isError?: boolean; structuredContent?: Structured } } | undefined;
  if (!envelope || envelope.error) throw new Error(`protocol error: ${envelope?.error?.message ?? response.status}`);
  return { isError: envelope.result?.isError === true, content: envelope.result?.structuredContent ?? {} };
}

/** Hour of day where a coverage runs, for service-hour expectations. */
function localHour(now: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
}

export async function runCanary(env: Env, now = Date.now()): Promise<CanaryReport> {
  const checks: CanaryCheck[] = [];
  const check = async (name: string, run: () => Promise<string>) => {
    const started = Date.now();
    try {
      const detail = await run(), ms = Date.now() - started;
      checks.push(ms > SLOW_MS ? { name, ok: false, ms, detail: `slow: ${detail}` } : { name, ok: true, ms, detail });
    } catch (error) { checks.push({ name, ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message.slice(0, 200) : 'failed' }); }
  };
  const expect = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await callTool(env, name, args);
    expect(!result.isError, `${result.content.code ?? 'error'}`);
    return result.content;
  };
  const rows = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const on = (coverage: string) => getCoverageMode(coverage, env) === 'on';
  const stop = (coverage: string, feed: string, id: string) => formatEntityRef({ coverage, feed, kind: 'stop', id });
  const route = (coverage: string, feed: string, id: string) => formatEntityRef({ coverage, feed, kind: 'route', id });

  if (on('nyc')) {
    // Subway and Manhattan buses run all night.
    await check('nyc.departures', async () => {
      const result = await tool('get_departures', { stop: 'Times Sq-42 St', coverage: 'nyc', limit: 5 });
      expect(result.status !== 'unavailable' && rows(result.departures) > 0, `no departures (${result.status} ${result.reasons})`);
      return `${result.status}, ${rows(result.departures)} rows`;
    });
    await check('nyc.plan', async () => {
      const result = await tool('plan_trip', { origin: { ref: stop('nyc', 'mta_subway', '635') }, destination: { ref: stop('nyc', 'mta_subway', 'D24') } });
      expect(rows(result.itineraries) > 0, `no itinerary (${result.reasons})`);
      return `${result.status}, ${rows(result.itineraries)} itineraries`;
    });
    await check('nyc.vehicles', async () => {
      const result = await tool('get_vehicle_status', { stop: 'Times Sq-42 St', coverage: 'nyc' });
      expect(result.status === 'realtime', `vehicles ${result.status} ${result.reasons}`);
      return `${rows(result.vehicles)} trains`;
    });
    await check('nyc.bus', async () => {
      const result = await tool('get_vehicle_status', { ref: route('nyc', 'mta_bus_m', 'M15') });
      expect(result.status === 'realtime' && rows(result.vehicles) > 0, `M15 ${result.status} ${result.reasons}`);
      return `${rows(result.vehicles)} buses`;
    });
    await check('nyc.status', async () => { const result = await tool('get_service_status', { coverage: 'nyc' }); return `${result.status}, ${rows(result.alerts)} alerts`; });
    await check('nyc.legacy', async () => { await tool('get_station_predictions', { city: 'nyc', stationName: '127' }); return 'ok'; });
  }
  if (on('dc')) {
    const hour = localHour(now, 'America/New_York'), service = hour >= 6 && hour < 22;
    await check('dc.departures', async () => {
      const result = await tool('get_departures', { stop: 'Metro Center', coverage: 'dc', limit: 5 });
      expect(result.status !== 'unavailable' && (!service || rows(result.departures) > 0), `no departures (${result.status} ${result.reasons})`);
      return `${result.status}, ${rows(result.departures)} rows`;
    });
    await check('dc.plan', async () => {
      const result = await tool('plan_trip', { origin: { ref: stop('dc', 'wmata', 'STN_A01_C01') }, destination: { ref: stop('dc', 'wmata', 'STN_C05') } });
      expect(!service || rows(result.itineraries) > 0, `no itinerary (${result.reasons})`);
      return `${result.status}, ${rows(result.itineraries)} itineraries`;
    });
    await check('dc.vehicles', async () => {
      const result = await tool('get_vehicle_status', { stop: 'Metro Center', coverage: 'dc' });
      expect(!service || result.status === 'realtime', `vehicles ${result.status} ${result.reasons}`);
      return `${rows(result.vehicles)} trains`;
    });
    await check('dc.bus', async () => {
      const result = await tool('get_vehicle_status', { ref: route('dc', 'wmata_bus', 'D80') });
      expect(!service || result.status === 'realtime', `D80 ${result.status} ${result.reasons}`);
      return `${rows(result.vehicles)} buses`;
    });
    await check('dc.status', async () => { const result = await tool('get_service_status', { coverage: 'dc' }); return `${result.status}, ${rows(result.alerts)} alerts`; });
    await check('dc.legacy', async () => { await tool('get_station_predictions', { city: 'dc', stationName: 'A01' }); return 'ok'; });
  }
  if (on('sfbay')) {
    const hour = localHour(now, 'America/Los_Angeles'), service = hour >= 6 && hour < 22;
    // Separate checks, each on its own budget: a slow plan is not a slow search.
    const find = async (query: string) => (await tool('find_transit', { query, coverage: 'sfbay', limit: 3 })).candidates?.find((item: Structured) => item.stopType === 'station');
    let sfo: Structured | undefined, powell: Structured | undefined, routes: string[] = [];
    await check('sfbay.search', async () => { sfo = await find('SFO'); powell = await find('Powell St'); expect(Boolean(sfo && powell), 'stations not found'); return `${sfo!.name}, ${powell!.name}`; });
    if (sfo && powell) {
      await check('sfbay.departures', async () => {
        const departures = await tool('get_departures', { stopRef: sfo!.ref, limit: 3 });
        expect(departures.status !== 'unavailable' && (!service || rows(departures.departures) > 0), `no SFO departures (${departures.status})`);
        return `${departures.status}, ${rows(departures.departures)} rows`;
      });
      await check('sfbay.route_hints', async () => {
        const hinted = await tool('plan_trip', { origin: { ref: sfo!.ref }, destination: { ref: powell!.ref } });
        routes = (hinted.routeHints?.direct ?? []).slice(0, 4).map((hint: Structured) => hint.ref);
        expect(routes.length > 0, 'no route hints');
        return `${routes.length} direct lines`;
      });
      if (routes.length) await check('sfbay.guided_plan', async () => {
        const guided = await tool('plan_trip', { origin: { ref: sfo!.ref }, destination: { ref: powell!.ref }, routes });
        expect(!service || rows(guided.itineraries) > 0, `no guided itinerary (${guided.reasons})`);
        return `${guided.status}, ${rows(guided.itineraries)} itineraries`;
      });
    }
  }
  return { at: new Date(now).toISOString(), ok: checks.every(item => item.ok), checks };
}

/** Runs the canary and keeps the latest report plus a short history in R2. */
export async function recordCanary(env: Env, now = Date.now()): Promise<CanaryReport> {
  const report = await runCanary(env, now);
  const previous = await env.TRANSIT_ARTIFACTS?.get(CANARY_KEY).then(object => object?.json<CanaryState>()).catch(() => undefined);
  const history = [...previous?.history ?? [], { at: report.at, ok: report.ok, failed: report.checks.filter(item => !item.ok).map(item => item.name) }].slice(-HISTORY);
  await env.TRANSIT_ARTIFACTS?.put(CANARY_KEY, JSON.stringify({ latest: report, history } satisfies CanaryState), { httpMetadata: { contentType: 'application/json' } });
  console[report.ok ? 'info' : 'warn'](JSON.stringify({ event: report.ok ? 'canary_passed' : 'canary_failed', failed: history.at(-1)!.failed,
    checks: report.checks.map(item => `${item.name}:${item.ok ? 'ok' : 'FAIL'}:${item.ms}ms`) }));
  return report;
}

/** 200 when the latest self-check passed within two days; 503 otherwise, for an uptime monitor. */
export async function canaryHealthResponse(env: Env, now = Date.now()): Promise<Response> {
  const state = await env.TRANSIT_ARTIFACTS?.get(CANARY_KEY).then(object => object?.json<CanaryState>()).catch(() => undefined);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (!state) return new Response(JSON.stringify({ ok: false, reason: 'no_report' }), { status: 503, headers });
  const ageSeconds = Math.round((now - Date.parse(state.latest.at)) / 1000), fresh = ageSeconds <= CANARY_STALE_SECONDS;
  const body = { ok: state.latest.ok && fresh, at: state.latest.at, ageSeconds, ...(fresh ? {} : { reason: 'stale_report' }),
    failures: state.latest.checks.filter(item => !item.ok), checks: state.latest.checks,
    recent: state.history.slice(-12).map(item => ({ at: item.at, ok: item.ok, failed: item.failed })) };
  return new Response(JSON.stringify(body, null, 2), { status: body.ok ? 200 : 503, headers });
}
