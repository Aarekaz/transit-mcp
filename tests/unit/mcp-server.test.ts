import {
  createRequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { MetroMcpContext, MetroRequestState } from '../../src/mcp/context';
import { createMetroMcpServer } from '../../src/mcp/server';
import { EXPECTED_TOOL_NAMES } from '../fixtures/mcp-contracts';
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

function untrustedContext(props: unknown, shortKey = false): MetroMcpContext {
  return {
    env: createMockEnv(shortKey ? { MCP_REQUEST_STATE_KEY: 'short' } : {}),
    era: 'modern',
    props,
  } as MetroMcpContext;
}

function stateContext(method = 'tools/call'): ServerContext {
  return { mcpReq: { method } } as ServerContext;
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

  it.each([
    ['a missing scope tuple', undefined],
    ['an empty scope tuple', []],
    ['an extra scope', ['transit:read', 'transit:write']],
  ])('rejects %s before any other factory validation', (_description, scopes) => {
    expect(() => createMetroMcpServer(untrustedContext({
      userId: '42',
      userLogin: 'anurag',
      clientId: 'claude',
      ...(scopes === undefined ? {} : { scopes }),
    }, true))).toThrow('insufficient_scope');
  });

  it.each([
    ['a blank user ID', {
      userId: ' ', userLogin: 'anurag', clientId: 'claude', scopes: ['transit:read'],
    }],
    ['a blank user login', {
      userId: '42', userLogin: ' ', clientId: 'claude', scopes: ['transit:read'],
    }],
    ['a blank client ID', {
      userId: '42', userLogin: 'anurag', clientId: ' ', scopes: ['transit:read'],
    }],
    ['a missing identity field', {
      userId: '42', clientId: 'claude', scopes: ['transit:read'],
    }],
    ['an extra identity field', {
      userId: '42',
      userLogin: 'anurag',
      clientId: 'claude',
      scopes: ['transit:read'],
      displayName: 'Anurag',
    }],
  ])('rejects %s before constructing request state', (_description, props) => {
    expect(() => createMetroMcpServer(untrustedContext(props, true))).toThrow('Invalid OAuth props');
  });

  it('normalizes direct factory props before binding request state', async () => {
    const key = 'test-mrtr-request-state-key-32-bytes-minimum';
    const highLevelServer = createMetroMcpServer(untrustedContext({
      userId: ' 42 ',
      userLogin: ' anurag ',
      clientId: ' claude ',
      scopes: ['transit:read'],
    }));
    const configured = highLevelServer.server as unknown as {
      _requestStateVerify: (state: string, context: ServerContext) => Promise<MetroRequestState>;
    };
    const referenceCodec = createRequestStateCodec<MetroRequestState>({
      key,
      ttlSeconds: 300,
      bind: context => ['42', context.mcpReq.method].join('\u0000'),
    });
    const context = stateContext();
    const payload: MetroRequestState = {
      phase: 'station-selection',
      tool: 'get_station_predictions',
      city: 'dc',
      query: 'metro center',
      candidateIds: ['A01'],
    };
    const state = await referenceCodec.mint(payload, context);

    await expect(configured._requestStateVerify(state, context)).resolves.toEqual(payload);
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

  it('registers the complete transit tool catalog in deterministic order', () => {
    const server = createMetroMcpServer(testContext()) as unknown as {
      _registeredTools: Record<string, unknown>;
    };

    expect(Object.keys(server._registeredTools)).toEqual(EXPECTED_TOOL_NAMES);
  });
});
