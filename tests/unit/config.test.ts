import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import stripJsonComments from 'strip-json-comments';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import type { Env } from '../../src/types';
import { createMockEnv } from '../setup';

const wranglerSource = readFileSync(
  new NodeURL('../../wrangler.jsonc', import.meta.url),
  'utf8',
);
const wrangler = JSON.parse(stripJsonComments(wranglerSource));

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

describe('anonymous deployment configuration', () => {
  it('loads the checked-in local development template as the exact anonymous contract', () => {
    const localVars = parseVarsExample(
      new NodeURL('../../.dev.vars.example', import.meta.url),
    );
    expect(Object.keys(localVars).sort()).toEqual([
      'ENVIRONMENT',
      'MCP_ALLOWED_HOSTNAMES',
      'MCP_ALLOWED_ORIGIN_HOSTNAMES',
      'MCP_PUBLIC_ORIGIN',
      'MCP_REQUEST_STATE_KEY',
      'WMATA_API_KEY',
    ]);

    const config = loadConfig({
      ...localVars,
      ASSETS: {} as Fetcher,
    } as Env);

    expect(config).toEqual({
      mcp: {
        publicOrigin: 'http://localhost:8787',
        resourceUri: 'http://localhost:8787/mcp',
        allowedHostnames: ['localhost'],
        allowedOriginHostnames: ['localhost'],
        requestStateKey: 'replace-with-a-local-request-state-key-at-least-32-bytes',
      },
      apis: { wmata: 'replace-with-your-local-wmata-api-key' },
      app: { environment: 'development', version: '5.0.0' },
    });
    expect(new TextEncoder().encode(localVars.MCP_REQUEST_STATE_KEY).byteLength)
      .toBeGreaterThanOrEqual(32);
  });

  it('derives one canonical MCP resource without an authentication policy', () => {
    const config = loadConfig(createMockEnv());

    expect(Object.keys(config).sort()).toEqual(['apis', 'app', 'mcp']);
    expect(config.mcp).toEqual({
      publicOrigin: 'https://metro-mcp.anuragd.me',
      resourceUri: 'https://metro-mcp.anuragd.me/mcp',
      allowedHostnames: ['metro-mcp.anuragd.me'],
      allowedOriginHostnames: ['metro-mcp.anuragd.me'],
      requestStateKey: 'test-mrtr-request-state-key-32-bytes-minimum',
    });
    expect(config.apis.wmata).toBe('test-wmata-key');
    expect(config.app.environment).toBe('production');
  });

  it.each([
    'MCP_PUBLIC_ORIGIN',
    'MCP_ALLOWED_HOSTNAMES',
    'MCP_ALLOWED_ORIGIN_HOSTNAMES',
    'MCP_REQUEST_STATE_KEY',
    'WMATA_API_KEY',
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
    }));

    expect(config.mcp.publicOrigin).toBe('https://metro-mcp.anuragd.me:8443');
    expect(config.mcp.resourceUri).toBe('https://metro-mcp.anuragd.me:8443/mcp');
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
      ENVIRONMENT: 'development',
    }));

    expect(config.mcp.resourceUri).toBe('http://localhost:8787/mcp');
    expect(config.app.environment).toBe('development');
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

  it('requires the MRTR key to contain at least 32 bytes', () => {
    expect(() => loadConfig(createMockEnv({ MCP_REQUEST_STATE_KEY: 'short' }))).toThrow(
      'at least 32 bytes',
    );
    expect(loadConfig(createMockEnv({ MCP_REQUEST_STATE_KEY: '🔐'.repeat(8) }))
      .mcp.requestStateKey).toBe('🔐'.repeat(8));
    expect(() => loadConfig(createMockEnv({ MCP_REQUEST_STATE_KEY: '🔐'.repeat(7) }))).toThrow(
      'at least 32 bytes',
    );
  });

  it.each(['test', 'staging', 'prod'])('rejects unsupported environment %s', environment => {
    expect(() => loadConfig(createMockEnv({
      ENVIRONMENT: environment as Env['ENVIRONMENT'],
    }))).toThrow(
      'ENVIRONMENT must be one of development, preview, production',
    );
  });

  it('declares only the public anonymous vars for production and preview', () => {
    expect(wrangler.keep_vars).toBe(false);
    expect(wrangler.vars).toEqual({
      MCP_PUBLIC_ORIGIN: 'https://metro-mcp.anuragd.me',
      MCP_ALLOWED_HOSTNAMES: 'metro-mcp.anuragd.me',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp.anuragd.me',
      ENVIRONMENT: 'production',
    });
    expect(wrangler.env.preview.vars).toEqual({
      MCP_PUBLIC_ORIGIN: 'https://metro-mcp-preview.anuragd.me',
      MCP_ALLOWED_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp-preview.anuragd.me',
      ENVIRONMENT: 'preview',
    });
    expect(wrangler.kv_namespaces).toBeUndefined();
    expect(wrangler.env.preview.kv_namespaces).toBeUndefined();
  });

  it('binds distinct production and preview anonymous MCP rate limit namespaces', () => {
    expect(wrangler.ratelimits).toEqual([{
      name: 'MCP_RATE_LIMITER',
      namespace_id: '2026082101',
      simple: { limit: 300, period: 60 },
    }]);
    expect(wrangler.env.preview.ratelimits).toEqual([{
      name: 'MCP_RATE_LIMITER',
      namespace_id: '2026082102',
      simple: { limit: 300, period: 60 },
    }]);
  });

  it('contains none of the removed authentication deployment names', () => {
    const removedNames = [
      ['OAUTH', 'KV'].join('_'),
      ['OAUTH', 'PROVIDER'].join('_'),
      ['GITHUB', 'CLIENT_ID'].join('_'),
      ['GITHUB', 'CLIENT_SECRET'].join('_'),
      ['OAUTH', 'REDIRECT_URI'].join('_'),
      ['JWT', 'SECRET'].join('_'),
    ];
    for (const name of removedNames) expect(wranglerSource).not.toContain(name);
  });

  it('keeps production and preview custom domains isolated', () => {
    expect(wrangler.routes).toEqual([{
      pattern: 'metro-mcp.anuragd.me',
      custom_domain: true,
    }]);
    expect(wrangler.env.preview.routes).toEqual([{
      pattern: 'metro-mcp-preview.anuragd.me',
      custom_domain: true,
    }]);
    expect(wrangler.env.preview.routes).not.toContainEqual(wrangler.routes[0]);
  });

  it('retains the original rollback migration without scheduling deletion', () => {
    expect(wrangler.migrations).toEqual([{
      tag: 'v1',
      new_sqlite_classes: ['MetroMcpAgent'],
    }]);
    expect(JSON.stringify(wrangler.migrations)).not.toContain('deleted_classes');
  });

  it('preserves anonymous assets and deployment controls', () => {
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
  });
});
