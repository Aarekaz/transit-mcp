import { describe, expect, it } from 'vitest';

import { handleMcpRequest } from '../../src/mcp/http-handler';
import { addSecurityHeadersAuto } from '../../src/middleware/security-headers';
import { createMockEnv } from '../setup';

const validProps = {
  userId: '42',
  userLogin: 'anurag',
  clientId: 'client-123',
  scopes: ['transit:read'] as ['transit:read'],
};

describe('handleMcpRequest', () => {
  it.each([
    undefined,
    {},
    { ...validProps, scopes: [] },
    { ...validProps, scopes: ['profile'] },
  ])('rejects absent or invalid authoritative props before MCP construction', async props => {
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: { Host: 'metro-mcp.anuragd.me' },
      }),
      createMockEnv(),
      undefined,
      props,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
    await expect(response.json()).resolves.toMatchObject({ error: 'insufficient_scope' });
  });

  it('accepts valid props when Provider AuthInfo is absent', async () => {
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: { Host: 'metro-mcp.anuragd.me' },
      }),
      createMockEnv(),
      undefined,
      validProps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('keeps the Agents modern MCP preflight policy through outer security composition', async () => {
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
      undefined,
      validProps,
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

  it('serves an ordinary legacy stateless request with props as the authority', async () => {
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
      undefined,
      validProps,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"id":1');
  });
});
