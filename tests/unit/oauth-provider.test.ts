import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerConstructor = vi.hoisted(() => vi.fn());

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    constructor(options: unknown) {
      providerConstructor(options);
    }
  },
}));

vi.mock('../../src/mcp/http-handler', () => ({
  handleMcpRequest: vi.fn(),
}));

import { createOAuthProvider } from '../../src/oauth/provider';
import { createMockEnv } from '../setup';

describe('createOAuthProvider', () => {
  beforeEach(() => {
    providerConstructor.mockClear();
  });

  it('uses the installed Provider 0.10.3 option contract and canonical resource', () => {
    const env = createMockEnv();
    createOAuthProvider(env, {} as ExecutionContext);

    expect(providerConstructor).toHaveBeenCalledOnce();
    expect(providerConstructor).toHaveBeenCalledWith(expect.objectContaining({
      apiRoute: '/mcp',
      apiHandler: { fetch: expect.any(Function) },
      defaultHandler: { fetch: expect.any(Function) },
      authorizeEndpoint: 'https://metro-mcp.anuragd.me/authorize',
      tokenEndpoint: 'https://metro-mcp.anuragd.me/token',
      clientRegistrationEndpoint: 'https://metro-mcp.anuragd.me/register',
      accessTokenTTL: 3_600,
      refreshTokenTTL: 2_592_000,
      clientRegistrationTTL: 7_776_000,
      scopesSupported: ['transit:read'],
      resourceMetadata: {
        resource: 'https://metro-mcp.anuragd.me/mcp',
        authorization_servers: ['https://metro-mcp.anuragd.me'],
        scopes_supported: ['transit:read'],
        bearer_methods_supported: ['header'],
        resource_name: 'Metro MCP',
      },
      clientIdMetadataDocumentEnabled: true,
      allowPlainPKCE: false,
      resolveExternalToken: expect.any(Function),
    }));
  });

  it('uses Provider-derived authorization-server metadata for HTTP loopback development', () => {
    const env = createMockEnv({
      MCP_PUBLIC_ORIGIN: 'http://localhost:8787',
      MCP_ALLOWED_HOSTNAMES: 'localhost',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'localhost,127.0.0.1',
      OAUTH_REDIRECT_URI: 'http://localhost:8787/callback',
      ENVIRONMENT: 'development',
    });

    createOAuthProvider(env, {} as ExecutionContext);

    expect(providerConstructor).toHaveBeenCalledWith(expect.objectContaining({
      authorizeEndpoint: 'http://localhost:8787/authorize',
      tokenEndpoint: 'http://localhost:8787/token',
      clientRegistrationEndpoint: 'http://localhost:8787/register',
      resourceMetadata: {
        resource: 'http://localhost:8787/mcp',
        scopes_supported: ['transit:read'],
        bearer_methods_supported: ['header'],
        resource_name: 'Metro MCP',
      },
    }));
  });
});
