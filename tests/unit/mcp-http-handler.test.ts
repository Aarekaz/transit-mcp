import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlerFetch = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());

vi.mock('agents/mcp/server', () => ({
  createMcpHandler: vi.fn(() => ({ fetch: handlerFetch })),
}));

vi.mock('../../src/mcp/server', () => ({
  createMetroMcpServer: vi.fn(),
}));

import { handleMcpRequest } from '../../src/mcp/http-handler';
import { addSecurityHeadersAuto } from '../../src/middleware/security-headers';
import { createMockEnv } from '../setup';

beforeEach(() => {
  handlerFetch.mockReset();
});

describe('handleMcpRequest', () => {
  it('serves anonymous preflight without Provider props or an authentication challenge', async () => {
    handlerFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: { Host: 'metro-mcp.anuragd.me' },
      }),
      createMockEnv(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.has('www-authenticate')).toBe(false);
  });

  it('removes a stale Authorization header before SDK dispatch', async () => {
    handlerFetch.mockResolvedValueOnce(Response.json({ result: { ok: true } }));
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Authorization: 'Bearer canary-do-not-log',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'server/discover',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
      }),
      createMockEnv(),
    );

    expect(response.status).toBe(200);
    expect(handlerFetch).toHaveBeenCalledOnce();
    expect(handlerFetch.mock.calls[0]![0].headers.has('authorization')).toBe(false);
  });

  it('keeps the Agents modern MCP preflight policy through outer security composition', async () => {
    handlerFetch.mockResolvedValueOnce(new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      },
    }));
    const mcpResponse = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Origin: 'https://metro-mcp.anuragd.me',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        },
      }),
      createMockEnv(),
    );

    const response = addSecurityHeadersAuto(mcpResponse);
    const allowedHeaders = response.headers.get('access-control-allow-headers') ?? '';

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-methods'))
      .toBe('GET, POST, DELETE, OPTIONS');
    expect(allowedHeaders).toContain('MCP-Protocol-Version');
    expect(allowedHeaders).toContain('Mcp-Method');
    expect(allowedHeaders).toContain('Mcp-Name');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves an ordinary legacy stateless request without an authorization object', async () => {
    handlerFetch.mockResolvedValueOnce(new Response('{"id":1}'));
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
      createMockEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"id":1');
  });
});
