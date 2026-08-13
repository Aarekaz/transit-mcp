import { describe, expect, it } from 'vitest';
import {
  parseMetroMcpProps,
  requireTransitRead,
} from '../../src/mcp/context';
import {
  PRIVATE_NO_CACHE,
  PUBLIC_24H,
  READ_ONLY_LIVE,
  complete,
  toolError,
  withTransitErrors,
} from '../../src/mcp/shared';

describe('Metro MCP authentication context', () => {
  it('accepts only the normalized read-only auth shape', () => {
    expect(parseMetroMcpProps({
      userId: '42',
      userLogin: 'anurag',
      clientId: 'claude',
      scopes: ['transit:read'],
    })).toEqual({
      userId: '42',
      userLogin: 'anurag',
      clientId: 'claude',
      scopes: ['transit:read'],
    });
  });

  it.each([
    ['an array', []],
    ['missing fields', { userId: '42', scopes: [] }],
    ['blank fields', {
      userId: ' ', userLogin: 'anurag', clientId: 'claude', scopes: ['transit:read'],
    }],
    ['an empty scope tuple', {
      userId: '42', userLogin: 'anurag', clientId: 'claude', scopes: [],
    }],
    ['an extra scope', {
      userId: '42',
      userLogin: 'anurag',
      clientId: 'claude',
      scopes: ['transit:read', 'transit:write'],
    }],
    ['a different scope', {
      userId: '42', userLogin: 'anurag', clientId: 'claude', scopes: ['transit:write'],
    }],
  ])('rejects %s', (_description, props) => {
    expect(() => parseMetroMcpProps(props)).toThrow('Invalid OAuth props');
  });

  it('rejects missing transit scope before server creation', () => {
    expect(() => requireTransitRead({
      userId: '42',
      userLogin: 'a',
      clientId: 'c',
      scopes: [],
    })).toThrow('insufficient_scope');
  });

  it('returns authorized props unchanged', () => {
    const props = parseMetroMcpProps({
      userId: '42',
      userLogin: 'anurag',
      clientId: 'claude',
      scopes: ['transit:read'],
    });

    expect(requireTransitRead(props)).toBe(props);
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
});
