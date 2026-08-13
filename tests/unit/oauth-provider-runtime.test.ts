import { describe, expect, it, vi } from 'vitest';

import { createOAuthProvider } from '../../src/oauth/provider';
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
  {
    name: 'development',
    origin: 'http://localhost:8787',
    env: (): Env => createMockEnv({
      MCP_PUBLIC_ORIGIN: 'http://localhost:8787',
      MCP_ALLOWED_HOSTNAMES: 'localhost',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'localhost,127.0.0.1',
      OAUTH_REDIRECT_URI: 'http://localhost:8787/callback',
      ENVIRONMENT: 'development',
    }),
  },
] as const;

describe('installed OAuth Provider runtime metadata', () => {
  it.each(deployments)('constructs and serves canonical $name metadata', async deployment => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = deployment.env();
    const ctx = executionContext();
    const provider = createOAuthProvider(env, ctx);
    const requestOrigin = 'https://request-origin.invalid';

    const authorizationResponse = await provider.fetch(
      new Request(`${requestOrigin}/.well-known/oauth-authorization-server`),
      env,
      ctx,
    );
    const protectedResponse = await provider.fetch(
      new Request(`${requestOrigin}/.well-known/oauth-protected-resource/mcp`),
      env,
      ctx,
    );
    const mcpResponse = await provider.fetch(
      new Request(`${deployment.origin}/mcp`, { method: 'POST' }),
      env,
      ctx,
    );
    const tokenResponse = await provider.fetch(
      new Request(`${deployment.origin}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code' }),
      }),
      env,
      ctx,
    );

    expect(authorizationResponse.status).toBe(200);
    await expect(authorizationResponse.json()).resolves.toMatchObject({
      issuer: deployment.origin,
      authorization_endpoint: `${deployment.origin}/authorize`,
      token_endpoint: `${deployment.origin}/token`,
      registration_endpoint: `${deployment.origin}/register`,
    });
    expect(protectedResponse.status).toBe(200);
    await expect(protectedResponse.json()).resolves.toEqual({
      resource: `${deployment.origin}/mcp`,
      authorization_servers: [deployment.origin],
      scopes_supported: ['transit:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Metro MCP',
    });
    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers.get('www-authenticate'))
      .toContain(`resource_metadata="${deployment.origin}/.well-known/oauth-protected-resource/mcp"`);
    expect(tokenResponse.status).not.toBe(404);
    expect(tokenResponse.headers.get('content-type')).toContain('application/json');
  });
});
