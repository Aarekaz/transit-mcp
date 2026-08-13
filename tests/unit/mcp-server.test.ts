import { describe, expect, it } from 'vitest';
import type { MetroMcpContext } from '../../src/mcp/context';
import { createMetroMcpServer } from '../../src/mcp/server';
import { createMockEnv } from '../setup';

function testContext(overrides: Partial<MetroMcpContext> = {}): MetroMcpContext {
  return {
    env: createMockEnv(),
    era: 'modern',
    props: {
      userId: '42',
      userLogin: 'anurag',
      clientId: 'claude',
      scopes: ['transit:read'],
    },
    ...overrides,
  };
}

describe('createMetroMcpServer', () => {
  it('constructs a fresh server for each factory call', () => {
    const a = createMetroMcpServer(testContext());
    const b = createMetroMcpServer(testContext());

    expect(a).not.toBe(b);
    expect(a.server).not.toBe(b.server);
  });

  it('fails construction when the request-state key is too short', () => {
    expect(() => createMetroMcpServer(testContext({
      env: createMockEnv({ MCP_REQUEST_STATE_KEY: 'short' }),
    }))).toThrow('key must be at least 32 bytes');
  });

  it('rejects a context without the transit read scope', () => {
    const context = testContext();
    const invalidContext = {
      ...context,
      props: { ...context.props, scopes: [] },
    } as unknown as MetroMcpContext;

    expect(() => createMetroMcpServer(invalidContext)).toThrow('insufficient_scope');
  });

  it('configures the documented cache and input-required policies', () => {
    const { server } = createMetroMcpServer(testContext());
    const configured = server as unknown as {
      _cacheHints: unknown;
      _inputRequiredServing: unknown;
      _requestStateVerify: unknown;
    };

    expect(configured._cacheHints).toEqual({
      'server/discover': { ttlMs: 86_400_000, cacheScope: 'public' },
      'tools/list': { ttlMs: 86_400_000, cacheScope: 'public' },
      'prompts/list': { ttlMs: 86_400_000, cacheScope: 'public' },
      'resources/list': { ttlMs: 86_400_000, cacheScope: 'public' },
      'resources/templates/list': { ttlMs: 86_400_000, cacheScope: 'public' },
      'resources/read': { ttlMs: 0, cacheScope: 'private' },
    });
    expect(configured._inputRequiredServing).toMatchObject({
      legacyShim: false,
      maxRounds: 1,
    });
    expect(configured._requestStateVerify).toBeTypeOf('function');
  });
});
