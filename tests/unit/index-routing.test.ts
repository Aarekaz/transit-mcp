import { describe, expect, it, vi } from 'vitest';

const providerFetch = vi.hoisted(() => vi.fn());

vi.mock('../../src/oauth/provider', () => ({
  createOAuthProvider: vi.fn(() => ({ fetch: providerFetch })),
}));

vi.mock('../../src/mcp-agent', () => ({
  MetroMcpAgent: class {},
}));

import worker from '../../src/index';
import { createMockEnv } from '../setup';

function executionContext(): ExecutionContext {
  return {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('Worker entry routing', () => {
  it('rewrites /sse before Provider dispatch and applies outer security metadata', async () => {
    providerFetch.mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const request = new Request('https://metro-mcp.anuragd.me/sse?trace=1', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer should-never-be-logged',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const env = createMockEnv();
    const ctx = executionContext();

    const response = await worker.fetch(request, env, ctx);

    expect(providerFetch).toHaveBeenCalledOnce();
    const [providerRequest, providerEnv, providerContext] = providerFetch.mock.calls[0]!;
    expect(new URL(providerRequest.url).pathname).toBe('/mcp');
    expect(new URL(providerRequest.url).search).toBe('?trace=1');
    expect(providerRequest.headers.get('authorization')).toBe('Bearer should-never-be-logged');
    expect(providerEnv).toBe(env);
    expect(providerContext).toBe(ctx);
    expect(response.status).toBe(202);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain('"alias":"/sse"');
    expect(String(info.mock.calls[0]?.[0])).not.toContain('should-never-be-logged');
  });

  it('rejects unsupported exact MCP methods before Provider dispatch', async () => {
    providerFetch.mockClear();

    const response = await worker.fetch(
      new Request('https://metro-mcp.anuragd.me/mcp?access_token=query-secret'),
      createMockEnv(),
      executionContext(),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
