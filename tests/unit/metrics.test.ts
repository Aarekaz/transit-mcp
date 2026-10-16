import { describe, expect, it, vi } from 'vitest';

import { recordMcpUsage } from '../../src/metrics';
import type { Env } from '../../src/types';

function envWithDataset(writeDataPoint: (point: unknown) => void): Env {
  return {
    ENVIRONMENT: 'production',
    ANALYTICS: { writeDataPoint },
  } as unknown as Env;
}

describe('recordMcpUsage', () => {
  it('records a tools/call with tool, session, environment and status', () => {
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
      indexes: ['sess-123'],
      blobs: ['tools/call', 'get_station_predictions', '', 'production', '2xx'],
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
    recordMcpUsage(env, { status: 404 });
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('is a no-op without the binding', () => {
    expect(() => recordMcpUsage(
      { ENVIRONMENT: 'production' } as unknown as Env,
      { mcpMethod: 'tools/call', mcpName: 'get_incidents', status: 200 },
    )).not.toThrow();
  });

  it('keeps the index within the 96-byte Analytics Engine limit', () => {
    const writeDataPoint = vi.fn();
    const env = envWithDataset(writeDataPoint);
    recordMcpUsage(env, { mcpMethod: 'tools/call', sessionId: 'a'.repeat(96), status: 200 });
    recordMcpUsage(env, { mcpMethod: 'tools/call', sessionId: 'a'.repeat(97), status: 200 });
    expect(writeDataPoint.mock.calls.map(([point]) => point.indexes)).toEqual([
      ['a'.repeat(96)],
      [''],
    ]);
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
