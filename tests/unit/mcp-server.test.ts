import {
  createRequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { MetroMcpContext, MetroRequestState } from '../../src/mcp/context';
import { createMetroMcpServer } from '../../src/mcp/server';
import {
  EXPECTED_TOOL_NAMES,
  TRANSIT_BOARD_MIME,
  TRANSIT_BOARD_TOOL_META,
} from '../fixtures/mcp-contracts';
import { createMockEnv } from '../setup';

function testContext(overrides: Partial<MetroMcpContext> = {}): MetroMcpContext {
  return {
    env: createMockEnv(),
    era: 'modern',
    ...overrides,
  };
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

  it('binds signed state to the exact MCP method without user props', async () => {
    const key = 'test-mrtr-request-state-key-32-bytes-minimum';
    const highLevelServer = createMetroMcpServer(testContext());
    const configured = highLevelServer.server as unknown as {
      _requestStateVerify: (state: string, context: ServerContext) => Promise<MetroRequestState>;
    };
    const referenceCodec = createRequestStateCodec<MetroRequestState>({
      key,
      ttlSeconds: 300,
      bind: context => context.mcpReq.method,
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
    await expect(configured._requestStateVerify(state, stateContext('prompts/get')))
      .rejects.toThrow('bind');
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
      _registeredTools: Record<string, { _meta?: unknown }>;
    };

    expect(Object.keys(server._registeredTools)).toEqual(EXPECTED_TOOL_NAMES);
    for (const tool of Object.values(server._registeredTools)) {
      expect(tool._meta).toEqual(TRANSIT_BOARD_TOOL_META);
    }
    expect(new Set(
      Object.values(server._registeredTools).map(tool => tool._meta),
    ).size).toBe(1);
    const meta = Object.values(server._registeredTools)[0]!._meta as {
      ui: { visibility: readonly string[] };
    };
    expect(Object.isFrozen(meta)).toBe(true);
    expect(Object.isFrozen(meta.ui)).toBe(true);
    expect(Object.isFrozen(meta.ui.visibility)).toBe(true);
  });

  it('configures only the stable Apps extension alongside registered features', () => {
    const { server } = createMetroMcpServer(testContext());

    expect(server.getCapabilities()).toEqual({
      extensions: {
        'io.modelcontextprotocol/ui': {
          mimeTypes: [TRANSIT_BOARD_MIME],
        },
      },
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    });
  });
});
