import { describe, expect, it, vi } from 'vitest';

const handleMcpRequest = vi.hoisted(() => vi.fn());

vi.mock('../../src/mcp/http-handler', () => ({
  handleMcpRequest,
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
  it('rewrites /sse before anonymous dispatch and applies outer security metadata', async () => {
    handleMcpRequest.mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }));
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

    expect(handleMcpRequest).toHaveBeenCalledOnce();
    const [handlerRequest, handlerEnv] = handleMcpRequest.mock.calls[0]!;
    expect(new URL(handlerRequest.url).pathname).toBe('/mcp');
    expect(new URL(handlerRequest.url).search).toBe('?trace=1');
    expect(handlerEnv).toBe(env);
    expect(response.status).toBe(202);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain('"alias":"/sse"');
    expect(String(info.mock.calls[0]?.[0])).not.toContain('should-never-be-logged');
  });

  it('rejects unsupported exact MCP methods before anonymous dispatch', async () => {
    handleMcpRequest.mockClear();

    const response = await worker.fetch(
      new Request('https://metro-mcp.anuragd.me/mcp?access_token=query-secret'),
      createMockEnv(),
      executionContext(),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    expect(handleMcpRequest).not.toHaveBeenCalled();
  });

  it('passes an accepted preflight through the assembled anonymous entry', async () => {
    const env = createMockEnv();
    handleMcpRequest.mockResolvedValueOnce(new Response(null, { status: 200, headers: {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    } }));

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
  ])('returns 404 for former OAuth routes through public routing for %s %s', async (method, path) => {
    handleMcpRequest.mockClear();
    const env = createMockEnv({ ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })) } as unknown as Fetcher });

    const response = await worker.fetch(
      new Request(`https://metro-mcp.anuragd.me${path}`, {
        method,
        headers: { Host: 'metro-mcp.anuragd.me' },
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(404);
    expect(handleMcpRequest).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'production',
      origin: 'https://metro-mcp.anuragd.me',
      env: createMockEnv(),
    },
    {
      name: 'preview',
      origin: 'https://metro-mcp-preview.anuragd.me',
      env: createMockEnv({
        MCP_PUBLIC_ORIGIN: 'https://metro-mcp-preview.anuragd.me',
        MCP_ALLOWED_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
        MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
        OAUTH_REDIRECT_URI: 'https://metro-mcp-preview.anuragd.me/callback',
        ENVIRONMENT: 'preview',
      }),
    },
  ])('never invokes anonymous MCP dispatch for non-canonical $name request origins', async deployment => {
    const hostname = new URL(deployment.origin).hostname;
    const insecureOrigin = deployment.origin.replace('https://', 'http://');

    for (const request of [
      new Request(`${insecureOrigin}/mcp`, {
        method: 'POST',
        headers: { Host: hostname },
      }),
      new Request(`${insecureOrigin}/sse`, {
        method: 'POST',
        headers: { Host: hostname },
      }),
      new Request('https://attacker.example/mcp', {
        method: 'POST',
        headers: { Host: hostname },
      }),
    ]) {
      handleMcpRequest.mockClear();

      const response = await worker.fetch(request, deployment.env, executionContext());

      expect(response.status).toBe(403);
      expect(handleMcpRequest).not.toHaveBeenCalled();
    }
  });
});
