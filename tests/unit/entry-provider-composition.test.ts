import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mcp-agent', () => ({
  MetroMcpAgent: class {},
}));

import worker from '../../src/index';
import type { Env } from '../../src/types';
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

describe('assembled Worker and real OAuth Provider', () => {
  it('keeps the Provider preflight policy through outer security composition', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Origin: 'https://metro-mcp.anuragd.me',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        },
      }),
      createMockEnv(),
      executionContext(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin'))
      .toBe('https://metro-mcp.anuragd.me');
    expect(response.headers.get('access-control-allow-methods')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization, *');
    expect(response.headers.get('access-control-expose-headers'))
      .toBe('WWW-Authenticate, Retry-After');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each(deployments)('rejects invalid Host before all $name Provider paths', async deployment => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (const request of [
      new Request('https://attacker.example/mcp', {
        method: 'POST',
        headers: { Host: 'attacker.example' },
      }),
      new Request('https://attacker.example/mcp', {
        method: 'OPTIONS',
        headers: { Host: 'attacker.example', Origin: deployment.origin },
      }),
      new Request('https://attacker.example/sse', {
        method: 'POST',
        headers: { Host: 'attacker.example' },
      }),
      new Request('https://attacker.example/.well-known/oauth-authorization-server', {
        headers: { Host: 'attacker.example' },
      }),
    ]) {
      const response = await worker.fetch(request, deployment.env(), executionContext());
      expect(response.status).toBe(403);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it.each(deployments)('advertises exact canonical $name discovery endpoints', async deployment => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const hostname = new URL(deployment.origin).hostname;
    const response = await worker.fetch(
      new Request(`${deployment.origin}/.well-known/oauth-authorization-server`, {
        headers: { Host: hostname },
      }),
      deployment.env(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issuer: deployment.origin,
      authorization_endpoint: `${deployment.origin}/authorize`,
      token_endpoint: `${deployment.origin}/token`,
      registration_endpoint: `${deployment.origin}/register`,
    });
  });

  it.each(deployments)(
    'rejects invalid Origin before unauthenticated $name MCP requests and preflight',
    async deployment => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const hostname = new URL(deployment.origin).hostname;

      for (const request of [
        new Request(`${deployment.origin}/mcp`, {
          method: 'POST',
          headers: { Host: hostname, Origin: 'https://attacker.example' },
        }),
        new Request(`${deployment.origin}/mcp`, {
          method: 'OPTIONS',
          headers: {
            Host: hostname,
            Origin: 'https://attacker.example',
            'Access-Control-Request-Method': 'POST',
          },
        }),
        new Request(`${deployment.origin}/sse`, {
          method: 'POST',
          headers: { Host: hostname, Origin: 'https://attacker.example' },
        }),
      ]) {
        const response = await worker.fetch(request, deployment.env(), executionContext());
        expect(response.status).toBe(403);
      }
    },
  );

  it.each(deployments)('allows an Origin-less $name desktop request to reach OAuth', async deployment => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const hostname = new URL(deployment.origin).hostname;
    const response = await worker.fetch(
      new Request(`${deployment.origin}/mcp`, {
        method: 'POST',
        headers: { Host: hostname },
      }),
      deployment.env(),
      executionContext(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate'))
      .toContain(`resource_metadata="${deployment.origin}/.well-known/oauth-protected-resource/mcp"`);
  });
});
