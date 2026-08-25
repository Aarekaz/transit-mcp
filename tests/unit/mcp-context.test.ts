import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MetroMcpContext } from '../../src/mcp/context';
import { createMockEnv } from '../setup';
import {
  PRIVATE_NO_CACHE,
  PUBLIC_24H,
  READ_ONLY_LIVE,
  complete,
  toolError,
  withTransitErrors,
} from '../../src/mcp/shared';

describe('Metro MCP anonymous context', () => {
  it('contains only request-independent server construction inputs', () => {
    const context = {
      env: createMockEnv(),
      era: 'modern',
    } satisfies MetroMcpContext;

    expect(context.era).toBe('modern');
    expectTypeOf(context).toMatchTypeOf<MetroMcpContext>();
  });
});

describe('shared MCP contracts', () => {
  it('defines read-only live annotations and cache policies', () => {
    expect(READ_ONLY_LIVE).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(PUBLIC_24H).toEqual({ ttlMs: 86_400_000, cacheScope: 'public' });
    expect(PRIVATE_NO_CACHE).toEqual({ ttlMs: 0, cacheScope: 'private' });
  });

  it('returns matching text and structured content', () => {
    const structured = { city: 'dc', totalStations: 98 };

    expect(complete(structured)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    });
  });

  it('returns a standard tool error result', () => {
    expect(toolError('No station found')).toEqual({
      content: [{ type: 'text', text: 'No station found' }],
      isError: true,
    });
  });

  it('normalizes transit failures while preserving cancellation identity', async () => {
    await expect(withTransitErrors(async () => {
      throw new Error('upstream failed');
    })).rejects.toThrow('Error: upstream failed');

    const abort = new DOMException('cancelled', 'AbortError');
    await expect(withTransitErrors(async () => {
      throw abort;
    })).rejects.toBe(abort);
  });

  it('preserves a caller-owned cancellation reason with a nonstandard name', async () => {
    const controller = new AbortController();
    const callerReason = new Error('caller cancelled');
    callerReason.name = 'RequestClosed';
    controller.abort(callerReason);

    await expect(withTransitErrors(async () => {
      throw controller.signal.reason;
    }, controller.signal)).rejects.toBe(controller.signal.reason);
  });
});
