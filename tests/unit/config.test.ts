import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import stripJsonComments from 'strip-json-comments';
import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from '../../src/config';
import type { Env } from '../../src/types';
import { createMockEnv } from '../setup';

describe('deployment configuration', () => {
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

  it('keeps the rollback MCP session binding in the named preview environment', () => {
    const example = JSON.parse(stripJsonComments(readFileSync(
      new NodeURL('../../wrangler.jsonc.example', import.meta.url),
      'utf8',
    )));

    expect(example.env.preview.durable_objects.bindings).toContainEqual({
      name: 'MCP_SESSION',
      class_name: 'MetroMcpAgent',
    });
    expect(example.migrations).toEqual([{
      tag: 'v1',
      new_sqlite_classes: ['MetroMcpAgent'],
    }]);
    expect(JSON.stringify(example.migrations)).not.toContain('deleted_classes');
  });
});
