import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = new URL('../../', import.meta.url);

function projectUrl(path: string): URL {
  return new URL(path, projectRoot);
}

function readProjectFile(path: string): string {
  return readFileSync(projectUrl(path), 'utf8');
}

const packageJson = JSON.parse(readProjectFile('package.json'));

const ACTIVE_REMOVAL_POLICY_TARGETS = [
  '.dev.vars.example',
  'bun.lock',
  'package.json',
  'src/config.ts',
  'src/index.ts',
  'src/mcp/http-handler.ts',
  'src/public-handler.ts',
  'src/types.ts',
  'tests/helpers/mcp-request.ts',
  'tests/setup.ts',
  'tests/unit/config.test.ts',
  'tests/unit/entry-anonymous-composition.test.ts',
  'tests/unit/index-routing.test.ts',
  'tests/unit/release-docs.test.ts',
  'vitest.workers.config.ts',
  'wrangler.jsonc',
  'wrangler.jsonc.example',
] as const;

// This is intentionally an explicit Task 2 inventory. This policy definition
// is not self-scanned because it states every forbidden literal readably.
// Historical plans, design specs, changelog entries, and release archaeology
// are not active deployment contracts and are deliberately outside this policy.
const REMOVED_IDENTIFIERS = [
  '@cloudflare/workers-oauth-provider',
  'OAUTH_KV',
  'OAUTH_PROVIDER',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'OAUTH_REDIRECT_URI',
  'JWT_SECRET',
  'legacyJwt',
  'LEGACY_JWT_CUTOFF',
  'accessTokenTtlSeconds',
  'refreshTokenTtlSeconds',
  'clientRegistrationTtlSeconds',
  'createOAuthProvider',
  'PendingGitHubLogin',
  'PendingConsent',
] as const;

const REMOVED_IMPLEMENTATION_FILES = [
  'src/oauth/github-handler.ts',
  'src/oauth/provider.ts',
  'src/oauth/legacy-token.ts',
  'tests/unit/github-oauth.test.ts',
  'tests/unit/legacy-token.test.ts',
  'tests/unit/oauth-provider.test.ts',
  'tests/unit/oauth-provider-runtime.test.ts',
] as const;

describe('MCP dependency policy', () => {
  it('pins the mutually compatible anonymous MCP stack exactly', () => {
    expect(packageJson.dependencies).toMatchObject({
      agents: '0.20.1',
      '@modelcontextprotocol/server': '2.0.0',
      '@modelcontextprotocol/client': '2.0.0',
      '@modelcontextprotocol/sdk': '1.30.0',
      zod: '4.4.3',
    });
    expect(packageJson.dependencies['@cloudflare/workers-oauth-provider']).toBeUndefined();
    expect(packageJson.devDependencies['@modelcontextprotocol/conformance'])
      .toBe('0.2.0-alpha.11');
  });

  it('keeps every Task 2 active target free of removed authentication identifiers', () => {
    for (const path of ACTIVE_REMOVAL_POLICY_TARGETS) {
      const source = readProjectFile(path);
      for (const identifier of REMOVED_IDENTIFIERS) {
        expect(source, `${path} must not contain ${identifier}`).not.toContain(identifier);
      }
    }
  });

  it('keeps authentication-only implementation modules and tests deleted', () => {
    for (const path of REMOVED_IMPLEMENTATION_FILES) {
      expect(existsSync(projectUrl(path)), `${path} must stay deleted`).toBe(false);
    }
  });

  it('keeps former authentication routes out of application dispatch', () => {
    const dispatchSource = [
      readProjectFile('src/index.ts'),
      readProjectFile('src/public-handler.ts'),
    ].join('\n');
    for (const route of [
      '/authorize',
      '/callback',
      '/token',
      '/register',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
    ]) {
      expect(dispatchSource, `${route} must not be dispatched`).not.toContain(route);
    }
  });

  it('dispatches anonymously without a Worker or Provider context', () => {
    const httpHandlerSource = readProjectFile('src/mcp/http-handler.ts');

    expect(httpHandlerSource).toContain('await handler.fetch(linked.request);');
    expect(httpHandlerSource).not.toContain('getMcpAuthContext');
    expect(httpHandlerSource).not.toContain('runWithAuthContext');
    expect(httpHandlerSource).not.toMatch(/handler\.fetch\(linked\.request\s*,/);
  });

  it('allows only the exact inert provider marker embedded by both pinned Agents entrypoints', () => {
    const activeAgentsEntry = readProjectFile('node_modules/agents/dist/mcp/server.js');
    const rollbackAgentsEntry = readProjectFile('node_modules/agents/dist/mcp/index.js');
    const vendorHandler = readProjectFile(
      'node_modules/agents/dist/handler-stateless-CIkKPETH.js',
    );
    const sharedHandlerModule = '../handler-stateless-CIkKPETH.js';
    const allowedVendorMarker = 'cloudflare.workers-oauth-provider.verified-context.v1';

    expect(activeAgentsEntry).toContain(sharedHandlerModule);
    expect(rollbackAgentsEntry).toContain(sharedHandlerModule);
    expect(vendorHandler.match(/workers-oauth-provider/g)).toEqual([
      'workers-oauth-provider',
    ]);
    expect(vendorHandler).toContain(`Symbol.for("${allowedVendorMarker}")`);
  });
});
