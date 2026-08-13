import { describe, expect, it } from 'vitest';

import { handleMcpRequest } from '../../src/mcp/http-handler';
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
