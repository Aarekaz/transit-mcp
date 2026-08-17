import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import stripJsonComments from 'strip-json-comments';
import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from '../../src/config';
import type { Env } from '../../src/types';
import { createMockEnv } from '../setup';

const wrangler = JSON.parse(stripJsonComments(readFileSync(
  new NodeURL('../../wrangler.jsonc', import.meta.url),
  'utf8',
)));

function parseVarsExample(url: NodeURL): Record<string, string> {
  return Object.fromEntries(
    readFileSync(url, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))
      .map(line => {
        const separator = line.indexOf('=');
        expect(separator).toBeGreaterThan(0);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function bindingNames(config: Record<string, any>): string[] {
  return [
    ...(config.durable_objects?.bindings ?? []),
    ...(config.kv_namespaces ?? []),
  ].map(binding => binding.name ?? binding.binding);
}

function oauthKvId(config: Record<string, any>): string {
  const binding = config.kv_namespaces?.find(
    (candidate: { binding?: string }) => candidate.binding === 'OAUTH_KV',
  );

  expect(binding).toBeDefined();
  expect(binding.id).toMatch(/^[a-f0-9]{32}$/);
  return binding.id;
}

describe('deployment configuration', () => {
  it('loads the checked-in local development template as the exact localhost contract', () => {
    const localVars = parseVarsExample(
      new NodeURL('../../.dev.vars.example', import.meta.url),
    );
    expect(Object.keys(localVars).sort()).toEqual([
      'ENVIRONMENT',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'JWT_SECRET',
      'MCP_ALLOWED_HOSTNAMES',
      'MCP_ALLOWED_ORIGIN_HOSTNAMES',
      'MCP_PUBLIC_ORIGIN',
      'MCP_REQUEST_STATE_KEY',
      'OAUTH_REDIRECT_URI',
      'WMATA_API_KEY',
    ]);

    const config = loadConfig({
      ...localVars,
      OAUTH_KV: {} as KVNamespace,
      OAUTH_PROVIDER: {} as Env['OAUTH_PROVIDER'],
      ASSETS: {} as Fetcher,
    } as Env);

    expect(config.mcp).toMatchObject({
      publicOrigin: 'http://localhost:8787',
      resourceUri: 'http://localhost:8787/mcp',
      allowedHostnames: ['localhost'],
      allowedOriginHostnames: ['localhost'],
    });
    expect(config.oauth).toMatchObject({
      github: {
        clientId: 'replace-with-your-local-github-oauth-app-client-id',
        clientSecret: 'replace-with-your-local-github-oauth-app-client-secret',
      },
      redirectUri: 'http://localhost:8787/callback',
    });
    expect(config.apis.wmata).toBe('replace-with-your-local-wmata-api-key');
    expect(config.app.environment).toBe('development');
    expect(config.mcp.requestStateKey).toBe(
      'replace-with-a-local-request-state-key-at-least-32-bytes',
    );
    expect(config.legacyJwt.secret).toBe(
      'replace-with-a-local-jwt-secret-at-least-32-bytes',
    );
    expect(new TextEncoder().encode(localVars.MCP_REQUEST_STATE_KEY).byteLength)
      .toBeGreaterThanOrEqual(32);
    expect(new TextEncoder().encode(localVars.JWT_SECRET).byteLength)
      .toBeGreaterThanOrEqual(32);
  });

  it('derives one canonical MCP resource', () => {
    const config = loadConfig(createMockEnv());

    expect(config.mcp.publicOrigin).toBe('https://metro-mcp.anuragd.me');
    expect(config.mcp.resourceUri).toBe('https://metro-mcp.anuragd.me/mcp');
    expect(config.mcp.allowedHostnames).toEqual(['metro-mcp.anuragd.me']);
    expect(config.mcp.allowedOriginHostnames).toEqual(['metro-mcp.anuragd.me']);
  });

  it('loads the fixed OAuth and legacy-token policy', () => {
    const config = loadConfig(createMockEnv());

    expect(config.oauth).toMatchObject({
      github: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      },
      redirectUri: 'https://metro-mcp.anuragd.me/callback',
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2_592_000,
      clientRegistrationTtlSeconds: 7_776_000,
    });
    expect(config.apis.wmata).toBe('test-wmata-key');
    expect(config.legacyJwt).toEqual({
      secret: 'test-jwt-secret-at-least-32-characters-long',
      cutoff: '2026-11-30T00:00:00Z',
    });
    expect(config.app.environment).toBe('production');
  });

  it.each([
    'MCP_PUBLIC_ORIGIN',
    'MCP_ALLOWED_HOSTNAMES',
    'MCP_ALLOWED_ORIGIN_HOSTNAMES',
    'MCP_REQUEST_STATE_KEY',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'OAUTH_REDIRECT_URI',
    'WMATA_API_KEY',
    'JWT_SECRET',
    'ENVIRONMENT',
  ])('requires %s', name => {
    expect(() => loadConfig(createMockEnv({ [name]: undefined }))).toThrow(
      `Missing required environment variables: ${name}`,
    );
  });

  it.each([
    ['https://metro-mcp.anuragd.me/path', 'must not contain a path'],
    ['https://metro-mcp.anuragd.me/', 'must not end with a slash'],
  ])('rejects invalid public origin %s', (origin, message) => {
    expect(() => loadConfig(createMockEnv({ MCP_PUBLIC_ORIGIN: origin }))).toThrow(message);
  });

  it.each([
    'https://metro-mcp.anuragd.me?',
    'https://metro-mcp.anuragd.me#',
    'https://@metro-mcp.anuragd.me',
    'https://user@metro-mcp.anuragd.me',
    'https://metro-mcp.anuragd.me/.',
    'https://metro-mcp.anuragd.me/..',
    'https://METRO-MCP.ANURAGD.ME',
    'https://metro-mcp.anuragd.me:443',
  ])('rejects non-canonical public origin spelling %s', origin => {
    expect(() => loadConfig(createMockEnv({ MCP_PUBLIC_ORIGIN: origin }))).toThrow(
      'must be a canonical origin',
    );
  });

  it('preserves an intentional non-default public-origin port', () => {
    const config = loadConfig(createMockEnv({
      MCP_PUBLIC_ORIGIN: 'https://metro-mcp.anuragd.me:8443',
      OAUTH_REDIRECT_URI: 'https://metro-mcp.anuragd.me:8443/callback',
    }));

    expect(config.mcp.publicOrigin).toBe('https://metro-mcp.anuragd.me:8443');
    expect(config.mcp.resourceUri).toBe('https://metro-mcp.anuragd.me:8443/mcp');
    expect(config.oauth.redirectUri).toBe('https://metro-mcp.anuragd.me:8443/callback');
  });

  it.each([
    ['not-a-url', 'must be a valid URL'],
    ['ftp://metro-mcp.anuragd.me', 'must use HTTPS'],
    ['http://metro-mcp.anuragd.me', 'must use HTTPS'],
  ])('rejects untrusted public origin %s', (origin, message) => {
    expect(() => loadConfig(createMockEnv({ MCP_PUBLIC_ORIGIN: origin }))).toThrow(message);
  });

  it('allows the documented loopback development origin', () => {
    const config = loadConfig(createMockEnv({
      MCP_PUBLIC_ORIGIN: 'http://localhost:8787',
      MCP_ALLOWED_HOSTNAMES: 'localhost',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'localhost,127.0.0.1',
      OAUTH_REDIRECT_URI: 'http://localhost:8787/callback',
      ENVIRONMENT: 'development',
    }));

    expect(config.mcp.resourceUri).toBe('http://localhost:8787/mcp');
    expect(config.app.environment).toBe('development');
  });

  it.each([
    'https://attacker.example/callback',
    'https://metro-mcp.anuragd.me/other',
  ])('rejects callback %s outside the exact configured endpoint', redirectUri => {
    expect(() => loadConfig(createMockEnv({ OAUTH_REDIRECT_URI: redirectUri }))).toThrow(
      'OAUTH_REDIRECT_URI must equal',
    );
  });

  it.each([
    ['MCP_ALLOWED_HOSTNAMES', '*'],
    ['MCP_ALLOWED_HOSTNAMES', 'https://example.com'],
    ['MCP_ALLOWED_HOSTNAMES', 'example.com:8787'],
    ['MCP_ALLOWED_ORIGIN_HOSTNAMES', 'example.com/path'],
  ])('rejects non-hostname entry in %s: %s', (name, value) => {
    expect(() => loadConfig(createMockEnv({ [name]: value }))).toThrow('hostname only');
  });

  it('normalizes comma-separated hostname lists', () => {
    const config = loadConfig(createMockEnv({
      MCP_ALLOWED_HOSTNAMES: ' metro-mcp.anuragd.me,api.example.com ',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp.anuragd.me, CLIENT.example.com',
    }));

    expect(config.mcp.allowedHostnames).toEqual([
      'metro-mcp.anuragd.me',
      'api.example.com',
    ]);
    expect(config.mcp.allowedOriginHostnames).toEqual([
      'metro-mcp.anuragd.me',
      'client.example.com',
    ]);
  });

  it('requires the public origin hostname in the request-host allowlist', () => {
    expect(() => loadConfig(createMockEnv({
      MCP_ALLOWED_HOSTNAMES: 'other.example.com',
    }))).toThrow('must include the MCP_PUBLIC_ORIGIN hostname');
  });

  it('requires a 32-byte MRTR key', () => {
    expect(() => loadConfig(createMockEnv({ MCP_REQUEST_STATE_KEY: 'short' }))).toThrow(
      'at least 32 bytes',
    );
  });

  it('measures the MRTR key as bytes', () => {
    const config = loadConfig(createMockEnv({ MCP_REQUEST_STATE_KEY: '🔐'.repeat(8) }));
    expect(config.mcp.requestStateKey).toBe('🔐'.repeat(8));
  });

  it('requires a 32-byte legacy JWT secret', () => {
    expect(() => loadConfig(createMockEnv({ JWT_SECRET: 'short' }))).toThrow(
      'JWT_SECRET must be at least 32 bytes',
    );
  });

  it('measures the legacy JWT secret as bytes', () => {
    const config = loadConfig(createMockEnv({ JWT_SECRET: '🔐'.repeat(8) }));
    expect(config.legacyJwt.secret).toBe('🔐'.repeat(8));

    expect(() => loadConfig(createMockEnv({ JWT_SECRET: '🔐'.repeat(7) }))).toThrow(
      'JWT_SECRET must be at least 32 bytes',
    );
  });

  it.each(['test', 'staging', 'prod'])('rejects unsupported environment %s', environment => {
    expect(() => loadConfig(createMockEnv({
      ENVIRONMENT: environment as Env['ENVIRONMENT'],
    }))).toThrow(
      'ENVIRONMENT must be one of development, preview, production',
    );
  });

  it('accepts the fixed preview environment name', () => {
    const config = loadConfig(createMockEnv({ ENVIRONMENT: 'preview' }));
    expect(config.app.environment).toBe('preview');
  });

  it.each([
    ['accessTokenTtlSeconds', 3599, 'must equal 3600'],
    ['refreshTokenTtlSeconds', 3600, 'must equal 2592000'],
    ['clientRegistrationTtlSeconds', 3600, 'must equal 7776000'],
  ])('rejects a changed OAuth %s policy', (field, value, message) => {
    const config = loadConfig(createMockEnv());
    Object.assign(config.oauth, { [field]: value });

    expect(() => validateConfig(config)).toThrow(message);
  });

  it('rejects a changed legacy JWT cutoff', () => {
    const config = loadConfig(createMockEnv());
    Object.assign(config.legacyJwt, { cutoff: '2027-01-01T00:00:00Z' });

    expect(() => validateConfig(config)).toThrow(
      'legacy JWT cutoff must equal 2026-11-30T00:00:00Z',
    );
  });

  it('isolates the production and preview OAuth origins', () => {
    expect(wrangler.vars).toMatchObject({
      MCP_PUBLIC_ORIGIN: 'https://metro-mcp.anuragd.me',
      MCP_ALLOWED_HOSTNAMES: 'metro-mcp.anuragd.me',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp.anuragd.me',
      OAUTH_REDIRECT_URI: 'https://metro-mcp.anuragd.me/callback',
      ENVIRONMENT: 'production',
    });
    expect(wrangler.env.preview.vars).toMatchObject({
      MCP_PUBLIC_ORIGIN: 'https://metro-mcp-preview.anuragd.me',
      MCP_ALLOWED_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
      OAUTH_REDIRECT_URI: 'https://metro-mcp-preview.anuragd.me/callback',
      ENVIRONMENT: 'preview',
    });
  });

  it('uses distinct real OAuth Provider storage in production and preview', () => {
    const productionId = oauthKvId(wrangler);
    const previewId = oauthKvId(wrangler.env.preview);

    expect(productionId).toBe('d93416b961b0442b80c04b0081105ff6');
    expect(previewId).toBe('e66115284977469fa58e5537976647f7');
    expect(previewId).not.toBe(productionId);
  });

  it('routes preview only through its independently approved custom domain', () => {
    expect(wrangler.env.preview.routes).toEqual([{
      pattern: 'metro-mcp-preview.anuragd.me',
      custom_domain: true,
    }]);
    expect(wrangler.env.preview.routes).not.toContainEqual({
      pattern: 'metro-mcp.anuragd.me',
      custom_domain: true,
    });
  });

  it('uses an independently coordinated GitHub OAuth app in preview', () => {
    const productionClientId = wrangler.vars.GITHUB_CLIENT_ID;
    const previewClientId = wrangler.env.preview.vars.GITHUB_CLIENT_ID;

    expect(previewClientId).toBe('Ov23li2oFCt24EJJ0X1O');
    expect(previewClientId).not.toBe(productionClientId);
  });

  it.each([
    ['production', wrangler],
    ['preview', wrangler.env?.preview],
  ])('does not expose active legacy bindings in %s', (_name, config) => {
    expect(bindingNames(config)).not.toEqual(expect.arrayContaining([
      'MCP_SESSION',
      'RATE_LIMIT_KV',
      'OAUTH_CLIENTS',
    ]));
  });

  it('retains the original rollback migration without scheduling deletion', () => {
    expect(wrangler.migrations).toEqual([{
      tag: 'v1',
      new_sqlite_classes: ['MetroMcpAgent'],
    }]);
    expect(JSON.stringify(wrangler.migrations)).not.toContain('deleted_classes');
  });

  it('enables strict public fetches without dropping deployment controls', () => {
    expect(wrangler.compatibility_flags).toEqual([
      'nodejs_compat',
      'global_fetch_strictly_public',
    ]);
    expect(wrangler.upload_source_maps).toBe(true);
    expect(wrangler.assets).toEqual({
      directory: './public',
      binding: 'ASSETS',
    });
    expect(wrangler.observability.enabled).toBe(true);
    expect(wrangler.routes).toContainEqual({
      pattern: 'metro-mcp.anuragd.me',
      custom_domain: true,
    });
  });
});
