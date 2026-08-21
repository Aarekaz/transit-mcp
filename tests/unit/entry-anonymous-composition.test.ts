import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mcp-agent', () => ({
  MetroMcpAgent: class {},
}));

import worker from '../../src/index';
import type { Env } from '../../src/types';
import { modernEnvelope } from '../helpers/mcp-request';
import { createMockEnv } from '../setup';

function executionContext(): ExecutionContext {
  return {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
}

const deployments = [
  {
    name: 'production',
    origin: 'https://metro-mcp.anuragd.me',
    env: (): Env => createMockEnv(),
  },
  {
    name: 'preview',
    origin: 'https://metro-mcp-preview.anuragd.me',
    env: (): Env => createMockEnv({
      MCP_PUBLIC_ORIGIN: 'https://metro-mcp-preview.anuragd.me',
      MCP_ALLOWED_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
      OAUTH_REDIRECT_URI: 'https://metro-mcp-preview.anuragd.me/callback',
      ENVIRONMENT: 'preview',
    }),
  },
] as const;

function modernRequest(origin: string, headers: HeadersInit = {}): Request {
  return new Request(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      Host: new URL(origin).hostname,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
      ...headers,
    },
    body: JSON.stringify(modernEnvelope('server/discover')),
  });
}

describe('assembled Worker anonymous stateless handler', () => {
  it.each(deployments)('serves $name server discovery without an initialization or authentication step', async deployment => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await worker.fetch(
      modernRequest(deployment.origin),
      deployment.env(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.has('www-authenticate')).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'metro-mcp' },
        },
      },
    });
  });

  it.each(deployments)('enforces exact origin, Host, and optional browser Origin for $name', async deployment => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const hostname = new URL(deployment.origin).hostname;
    const requests = [
      modernRequest(deployment.origin.replace('https://', 'http://')),
      modernRequest(deployment.origin, { Host: 'attacker.example' }),
      modernRequest(deployment.origin, { Origin: 'https://attacker.example' }),
    ];

    for (const request of requests) {
      const response = await worker.fetch(request, deployment.env(), executionContext());
      expect(response.status).toBe(403);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }

    const desktopResponse = await worker.fetch(
      modernRequest(deployment.origin, { Host: hostname }),
      deployment.env(),
      executionContext(),
    );
    expect(desktopResponse.status).toBe(200);
  });
});
