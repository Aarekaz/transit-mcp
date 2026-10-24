import { describe, expect, it, vi } from 'vitest';

import { recordMcpUsage } from '../../src/metrics';
import type { Env } from '../../src/types';
import { createMockEnv } from '../setup';
import { handleMcpRequest } from '../../src/mcp/http-handler';
import type { TelemetryInput } from '../../src/telemetry';
import worker from '../../src/index';

vi.mock('../../src/mcp-agent', () => ({ MetroMcpAgent: class {} }));
import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { StaticArtifactStore } from '../../src/transit/gtfs/realtime/snapshot-store';
import { memoryStorage } from '../helpers/realtime-fixture';
import { plannerInput } from '../helpers/planner-fixture';

function envWithDataset(writeDataPoint: (point: unknown) => void): Env {
  return {
    ENVIRONMENT: 'production',
    ANALYTICS: { writeDataPoint },
  } as unknown as Env;
}

describe('recordMcpUsage', () => {
  it.each(['legacy', 'modern'] as const)('does not count a rejected %s initialize before SDK era classification', async protocol => {
    const points: unknown[] = [];
    const env = createMockEnv({ ANALYTICS: { writeDataPoint: point => points.push(point) } as AnalyticsEngineDataset });
    const telemetry: TelemetryInput = {};
    const headers = new Headers({ Host: 'metro-mcp.anuragd.me', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Origin: 'https://untrusted.example' });
    if (protocol === 'modern') headers.set('MCP-Protocol-Version', '2026-07-28');
    const response = await handleMcpRequest(new Request('https://metro-mcp.anuragd.me/mcp', {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: protocol === 'modern' ? '2026-07-28' : '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT', version: '1' },
      } }),
    }), env, undefined, telemetry);
    await response.text();
    expect(response.status).toBe(403);
    expect(telemetry.mcpMethod).toBe('initialize');
    expect(telemetry.era).toBeUndefined();
    recordMcpUsage(env, { ...telemetry, status: response.status });
    expect(points).toEqual([]);
  });

  it('records initialize only after the real handler confirms the legacy era', async () => {
    const points: unknown[] = [];
    const env = createMockEnv({ ANALYTICS: { writeDataPoint: point => points.push(point) } as AnalyticsEngineDataset });
    const telemetry: TelemetryInput = {};
    const response = await handleMcpRequest(new Request('https://metro-mcp.anuragd.me/mcp', {
      method: 'POST', headers: { Host: 'metro-mcp.anuragd.me', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT', version: '1' },
      } }),
    }), env, undefined, telemetry);
    await response.text();
    expect(response.status).toBe(200);
    expect(telemetry.era).toBe('legacy');
    recordMcpUsage(env, { ...telemetry, status: response.status });
    expect(points).toEqual([{ indexes: [''], blobs: ['initialize', '', 'ChatGPT', 'production', '2xx', '', ''], doubles: [0] }]);
  });

  it.each([undefined, null, 'invalid', 'modern'])('rejects initialize without affirmative legacy era (%s)', era => {
    const points: unknown[] = [];
    recordMcpUsage(envWithDataset(point => points.push(point)), { mcpMethod: 'initialize', era, status: 200 });
    expect(points).toEqual([]);
  });

  it('does not turn mismatched headers or malformed envelopes into recorded tool calls', async () => {
    const points: unknown[] = [];
    const env = createMockEnv({ ANALYTICS: { writeDataPoint: point => points.push(point) } as AnalyticsEngineDataset });
    for (const body of ['{bad-json', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    } })]) {
      const telemetry: TelemetryInput = {};
      const response = await handleMcpRequest(new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST', headers: { Host: 'metro-mcp.anuragd.me', 'Content-Type': 'application/json', Accept: 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'plan_trip' }, body,
      }), env, undefined, telemetry);
      await response.text();
      recordMcpUsage(env, telemetry);
    }
    expect(points).toEqual([]);
  });
  it('records aggregate tools/call dimensions without a session identifier', () => {
    const writeDataPoint = vi.fn();
    recordMcpUsage(envWithDataset(writeDataPoint), {
      mcpMethod: 'tools/call',
      mcpName: 'get_station_predictions',
      sessionId: 'sess-123',
      durationMs: 42,
      status: 200,
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: [''],
      blobs: ['tools/call', 'get_station_predictions', 'unclassified', 'production', '2xx', '', ''],
      doubles: [42],
    });
  });

  it('records confirmed legacy initialize with the client name', () => {
    const writeDataPoint = vi.fn();
    recordMcpUsage(envWithDataset(writeDataPoint), {
      mcpMethod: 'initialize',
      era: 'legacy',
      clientName: 'ChatGPT',
      status: 200,
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: [''],
      blobs: ['initialize', '', 'ChatGPT', 'production', '2xx', '', ''],
      doubles: [0],
    });
  });

  it('ignores other methods and non-MCP requests', () => {
    const writeDataPoint = vi.fn();
    const env = envWithDataset(writeDataPoint);
    recordMcpUsage(env, { mcpMethod: 'tools/list', status: 200 });
    recordMcpUsage(env, { mcpMethod: 'ping', status: 200 });
    recordMcpUsage(env, { mcpMethod: 'initialize', era: 'modern', status: 400 });
    recordMcpUsage(env, { status: 404 });
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('is a no-op without the binding', () => {
    expect(() => recordMcpUsage(
      { ENVIRONMENT: 'production' } as unknown as Env,
      { mcpMethod: 'tools/call', mcpName: 'get_incidents', status: 200 },
    )).not.toThrow();
  });

  it('drops every session identifier regardless of its length', () => {
    const writeDataPoint = vi.fn();
    const env = envWithDataset(writeDataPoint);
    recordMcpUsage(env, { mcpMethod: 'tools/call', sessionId: 'a'.repeat(96), status: 200 });
    recordMcpUsage(env, { mcpMethod: 'tools/call', sessionId: 'a'.repeat(97), status: 200 });
    expect(writeDataPoint.mock.calls.map(([point]) => point.indexes)).toEqual([
      [''],
      [''],
    ]);
  });

  it('separates preview and production while rejecting arbitrary environment values', () => {
    const points: unknown[] = [];
    for (const environment of ['production', 'preview', 'private-address']) {
      recordMcpUsage({ ...envWithDataset(point => points.push(point)), ENVIRONMENT: environment } as Env,
        { mcpMethod: 'tools/call', mcpName: 'plan_trip', status: 200, arguments: { latitude: 37, longitude: -122 } });
    }
    expect(points).toEqual(['production', 'preview', 'unclassified'].map(environment => ({
      indexes: [''], blobs: ['tools/call', 'plan_trip', 'unclassified', environment, '2xx', '', ''], doubles: [0],
    })));
  });

  it('never throws even when reading the binding fails', () => {
    const env = { ENVIRONMENT: 'production' } as unknown as Env;
    Object.defineProperty(env, 'ANALYTICS', {
      get() {
        throw new Error('binding unavailable');
      },
    });
    expect(() => recordMcpUsage(env, { mcpMethod: 'tools/call', status: 200 })).not.toThrow();
  });

  it('drops unsafe session ids and never throws when the dataset fails', () => {
    const failing = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => recordMcpUsage(envWithDataset(failing), {
      mcpMethod: 'tools/call',
      mcpName: 'get_incidents',
      sessionId: 'bad session!',
      status: 500,
    })).not.toThrow();

    const writeDataPoint = vi.fn();
    recordMcpUsage(envWithDataset(writeDataPoint), {
      mcpMethod: 'tools/call',
      mcpName: 'get_incidents',
      sessionId: 'bad session!',
      status: 500,
    });
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ indexes: [''] }));
  });
});

describe('anonymous usage reporting', () => {
  it('builds a read-only sampled aggregate query with only explicit exclusions', async () => {
    const usage = await import('../../scripts/query-anonymous-usage').catch(() => undefined);
    expect(usage, 'usage query module must exist').toBeDefined();
    const sql = usage!.buildUsageQuery({ start: '2026-10-01', end: '2026-10-03', environment: 'production', excludeClients: ['transit-prompt-evals'] });
    expect(sql).toMatch(/^SELECT /);
    expect(sql).toContain("SELECT formatDateTime(timestamp, '%Y-%m-%d', 'UTC') AS day, blob1 AS method");
    expect(sql).not.toMatch(/\btoDate\s*\(/i);
    expect(sql).toContain('SUM(_sample_interval)');
    expect(sql).toContain("blob1 IN ('tools/call', 'initialize')");
    expect(sql).toContain("blob4 = 'production'");
    expect(sql).toContain("blob3 NOT IN ('transit-prompt-evals')");
    expect(sql).not.toMatch(/index1|SELECT \*|INSERT|UPDATE|DELETE|arguments|latitude|longitude/);
    const defaults = usage!.buildUsageQuery({ start: '2026-10-01', end: '2026-10-03', environment: 'preview' });
    expect(defaults).not.toContain('NOT IN');
    expect(defaults).toContain("blob4 = 'preview'");
    for (const invalid of [
      { start: '2026-02-30' }, { end: '2026-09-01' },
      { environment: "production' OR 1=1" }, { excludeClients: ['my-private-client'] },
    ]) expect(() => usage!.buildUsageQuery({ start: '2026-10-01', end: '2026-10-03', environment: 'production', ...invalid })).toThrow();
  });

  it('separates initialize, counts HTTP successes, and never emits historical private row fields', async () => {
    const usage = await import('../../scripts/query-anonymous-usage').catch(() => undefined);
    expect(usage, 'usage report module must exist').toBeDefined();
    const report = usage!.summarizeUsage([
      { day: '2026-10-01', method: 'tools/call', tool: 'plan_trip', client: 'ChatGPT', environment: 'production', status: '2xx', count: '8' },
      { day: '2026-10-01', method: 'tools/call', tool: 'private-ref', client: 'private-alias', environment: 'production', status: '5xx', count: 2, index1: 'stable-identifier', arguments: { latitude: 37 } },
      { day: '2026-10-02', method: 'tools/call', tool: 'find_transit', client: '', environment: 'preview', status: '2xx', count: 3 },
      { day: '2026-10-02', method: 'initialize', client: 'ChatGPT', environment: 'production', status: '2xx', count: 9 },
      { day: '2026-10-02', method: 'tools/list', count: 99 },
    ]);
    expect(report.toolCalls).toBe(13);
    expect(report.httpSuccessfulToolCalls).toBe(11);
    expect(report.legacyInitializeEvents).toBe(9);
    expect(report.tools).toEqual({ plan_trip: 8, unclassified: 2, find_transit: 3 });
    expect(report.clients).toEqual({ ChatGPT: 8, unclassified: 5 });
    expect(report.environments).toEqual({ production: 10, preview: 3 });
    expect(report.daily).toEqual({ '2026-10-01': 10, '2026-10-02': 3 });
    expect(JSON.stringify(report)).not.toMatch(/private-ref|private-alias|stable-identifier|latitude|arguments|index1/);
    expect(report.limitations.join(' ')).toMatch(/HTTP 2xx.*tool errors/);
    expect(report.limitations.join(' ')).toMatch(/unclassified/);
    expect(() => usage!.summarizeUsage([{ day: '2026-10-01', method: 'tools/call', count: -1 }])).toThrow();
  });
});

describe('usage by region and feed', () => {
  it('records the regions and feeds an answer drew on, from its refs and never from what was asked', async () => {
    const compiled = await compileSchedule(plannerInput()), db = memoryStorage();
    db.objects.set(compiled.manifest.discoveries[0]!.key, compiled.discoveryBytes);
    db.objects.set(compiled.manifest.shards[0]!.key, compiled.shardBytes);
    await new StaticArtifactStore(db.bucket).publish(compiled.manifest);
    const points: { blobs: string[] }[] = [], pending: Promise<unknown>[] = [];
    const env = createMockEnv({ SFBAY_MODE: 'on', TRANSIT_ARTIFACTS: db.bucket, ENVIRONMENT: 'production',
      ANALYTICS: { writeDataPoint: point => points.push(point as { blobs: string[] }) } as AnalyticsEngineDataset });
    const ask = (query: string) => worker.fetch(new Request('https://metro-mcp.anuragd.me/mcp', { method: 'POST',
      headers: { Host: 'metro-mcp.anuragd.me', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_transit', arguments: { coverage: 'sfbay', query } } }) }),
      env, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: vi.fn() } as unknown as ExecutionContext)
      .then(async response => { const text = await response.text(); await Promise.all(pending); return text; });
    expect(await ask('Origin')).toContain('tr:sfbay:sf511:');
    expect(points.at(-1)!.blobs).toEqual(['tools/call', 'find_transit', 'unclassified', 'production', '2xx', 'sfbay', 'sf511']);
    // Nothing found: no region is claimed, and the words asked are never recorded.
    await ask('Zzyzx Road');
    expect(points.at(-1)!.blobs.slice(5)).toEqual(['', '']);
    expect(JSON.stringify(points)).not.toMatch(/Origin|Zzyzx/);
  });

  it('keeps only known regions and feeds', () => {
    const points: { blobs: string[] }[] = [];
    recordMcpUsage(envWithDataset(point => points.push(point as { blobs: string[] })), { mcpMethod: 'tools/call', mcpName: 'get_departures', status: 200,
      coverage: ['nyc', 'Times Square', 'dc'], feeds: ['mta_subway', 'wmata', 'tr:nyc', '42 St', 'mta_subway'] });
    expect(points[0]!.blobs.slice(5)).toEqual(['dc+nyc', 'mta_subway+wmata']);
  });
});
