import { describe, expect, it } from 'vitest';

import { normalizeMcpRoute } from '../../src/route-normalizer';

function expectAdmitted(
  result: ReturnType<typeof normalizeMcpRoute>,
  alias: '/mcp' | '/sse',
): Request {
  expect(result).toMatchObject({ alias });
  if (!result || result instanceof Response) {
    throw new Error('expected normalized MCP route');
  }
  return result.request;
}

describe('normalizeMcpRoute', () => {
  it.each(['POST', 'OPTIONS'])('rewrites exact /sse %s before dispatch', async method => {
    const original = new Request('https://metro-mcp.anuragd.me/sse?trace=1', {
      method,
      headers: { Authorization: 'Bearer secret', 'X-Probe': 'kept' },
      body: method === 'POST' ? '{}' : undefined,
    });

    const normalized = normalizeMcpRoute(original);
    const request = expectAdmitted(normalized, '/sse');

    expect(new URL(request.url).pathname).toBe('/mcp');
    expect(new URL(request.url).search).toBe('?trace=1');
    expect(request.method).toBe(method);
    expect(request.headers.get('Authorization')).toBe('Bearer secret');
    expect(request.headers.get('X-Probe')).toBe('kept');
    if (method === 'POST') {
      await expect(request.text()).resolves.toBe('{}');
    }
  });

  it.each(['POST', 'OPTIONS'])('admits exact /mcp %s without rewriting it', method => {
    const original = new Request('https://metro-mcp.anuragd.me/mcp?trace=1', { method });
    const request = expectAdmitted(normalizeMcpRoute(original), '/mcp');

    expect(request).toBe(original);
    expect(request.url).toBe('https://metro-mcp.anuragd.me/mcp?trace=1');
  });

  it.each(['/sse', '/mcp'])('rejects unsupported transport methods on %s', path => {
    for (const method of ['GET', 'DELETE', 'PATCH']) {
      const result = normalizeMcpRoute(new Request(`https://metro-mcp.anuragd.me${path}`, {
        method,
      }));

      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw new Error('expected method rejection');
      expect(result.status).toBe(405);
      expect(result.headers.get('Allow')).toBe('POST, OPTIONS');
    }
  });

  it.each(['/sse/', '/sse/messages', '/mcp/', '/mcp/session'])('does not broaden %s', path => {
    const result = normalizeMcpRoute(new Request(`https://metro-mcp.anuragd.me${path}`, {
      method: 'POST',
    }));

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error('expected method rejection');
    expect(result.status).toBe(405);
    expect(result.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it.each(['/', '/info', '/authorize', '/mcpx', '/sse-other'])('ignores non-MCP route %s', path => {
    expect(normalizeMcpRoute(new Request(`https://metro-mcp.anuragd.me${path}`)))
      .toBeUndefined();
  });
});
