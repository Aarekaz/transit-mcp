import { describe, expect, it, vi } from 'vitest';

const providerFetch = vi.hoisted(() => vi.fn());

vi.mock('../../src/oauth/provider', () => ({
  createOAuthProvider: vi.fn(() => ({ fetch: providerFetch })),
}));

vi.mock('../../src/mcp-agent', () => ({
  MetroMcpAgent: class {},
}));

import worker from '../../src/index';
import { handleMcpRequest } from '../../src/mcp/http-handler';
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
        Host: 'metro-mcp.anuragd.me',
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

  it('keeps the real Agents modern preflight policy through the assembled entry', async () => {
    const env = createMockEnv();
    providerFetch.mockImplementationOnce((request: Request) => handleMcpRequest(
      request,
      env,
      undefined,
      {
        userId: '42',
        userLogin: 'anurag',
        clientId: 'client-123',
        scopes: ['transit:read'],
      },
    ));

    const response = await worker.fetch(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Origin: 'https://metro-mcp.anuragd.me',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        },
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-methods'))
      .toBe('GET, POST, DELETE, OPTIONS');
    expect(response.headers.get('access-control-allow-headers'))
      .toBe('Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each([
    ['GET', '/authorize'],
    ['POST', '/authorize/decision'],
    ['GET', '/callback'],
    ['POST', '/token'],
    ['POST', '/register'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/.well-known/oauth-protected-resource/mcp'],
  ])('rejects an untrusted Host before Provider dispatch for %s %s', async (method, path) => {
    providerFetch.mockClear();
    providerFetch.mockResolvedValueOnce(new Response('provider reached'));

    const response = await worker.fetch(
      new Request(`https://attacker.example${path}`, {
        method,
        headers: { Host: 'attacker.example' },
      }),
      createMockEnv(),
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
