import { describe, expect, it, vi } from 'vitest';

import { recordMcpUsage } from '../../src/metrics';
import type { Env } from '../../src/types';
import { createMockEnv } from '../setup';
import { handleMcpRequest } from '../../src/mcp/http-handler';
import type { TelemetryInput } from '../../src/telemetry';

function envWithDataset(writeDataPoint: (point: unknown) => void): Env {
  return {
    ENVIRONMENT: 'production',
    ANALYTICS: { writeDataPoint },
  } as unknown as Env;
}

describe('recordMcpUsage', () => {
  it('does not turn mismatched headers or malformed envelopes into recorded tool calls', async () => {
    const points: unknown[] = [];
    const env = createMockEnv({ ANALYTICS: { writeDataPoint: point => points.push(point) } as AnalyticsEngineDataset });
    for (const body of ['{bad-json', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    } })]) {
      const telemetry: TelemetryInput = {};
      const response = await handleMcpRequest(new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'plan_trip' }, body,
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
      blobs: ['tools/call', 'get_station_predictions', 'unclassified', 'production', '2xx'],
      doubles: [42],
    });
  });

  it('records initialize with the client name', () => {
    const writeDataPoint = vi.fn();
    recordMcpUsage(envWithDataset(writeDataPoint), {
      mcpMethod: 'initialize',
      clientName: 'ChatGPT',
      status: 200,
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: [''],
      blobs: ['initialize', '', 'ChatGPT', 'production', '2xx'],
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
      indexes: [''], blobs: ['tools/call', 'plan_trip', 'unclassified', environment, '2xx'], doubles: [0],
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
