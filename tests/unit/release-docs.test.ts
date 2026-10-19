import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url).pathname, 'utf8');
const readOptionalProjectFile = (path: string): string => {
  const file = new URL(`../../${path}`, import.meta.url).pathname;
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const readme = readProjectFile('README.md');
const securityGuide = readProjectFile('docs/SECURITY.md');
const changelog = readProjectFile('CHANGELOG.md');
const protocolVerification = readProjectFile('docs/mcp-2026-verification.md');
const appsVerification = readProjectFile('docs/mcp-apps-verification.md');
const landingPage = readProjectFile('public/index.html');
const publicDocs = readProjectFile('public/docs/index.html');
const llmsText = readProjectFile('public/llms.txt');
const sfBayRollout = readProjectFile('docs/sfbay-rollout.md');
const privacy = readProjectFile('public/privacy/index.html');
const terms = readProjectFile('public/terms/index.html');
const support = readProjectFile('public/support/index.html');
const ogImageSvg = readProjectFile('public/og-image.svg');
const transitBoardSource = readProjectFile('apps/transit-board/transit-board.html');
const registry = readProjectFile('server.json');
const wrangler = readProjectFile('wrangler.jsonc');
const appsHostHtml = readOptionalProjectFile('tests/apps/host.html');
const appsHostSource = readOptionalProjectFile('tests/apps/host.ts');
const packageJson = JSON.parse(readProjectFile('package.json')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const workflow = readOptionalProjectFile('.github/workflows/type-check.yml');

const forbiddenSfLiveClaimPatterns = [
  /(?:live|real-time)[^.!?\n]{0,120}(?:San Francisco |SF )?Bay Area/i,
  /(?:San Francisco |SF )?Bay Area[^.!?\n]{0,120}(?:live|real-time)/i,
  /(?:live|real-time)\s+SF Bay\b/i,
  /\bSF Bay\b[^.!?\n]{0,40}(?:is\s+)?(?:live|real-time)\b/i,
] as const;

describe('release operator documentation', () => {
  it('routes public LLM guidance by runtime planning capability and retains legacy lookup limits', () => {
    expect(llmsText).toMatch(/find_transit.*availability.*planning/);
    expect(llmsText).toMatch(/plan_trip.*only when/);
    expect(llmsText).toContain('do not provide a full journey planner');
    expect(llmsText).toContain('minutesAway');
  });
  it('keeps SF Bay dark while documenting the in-development rollout', () => {
    for (const [name, document] of [
      ['README', readme],
      ['landing page', landingPage],
      ['public docs', publicDocs],
      ['LLM index', llmsText],
      ['changelog', changelog],
    ] as const) {
      expect(document, name).toMatch(/SF Bay support is in development/i);
    }

    for (const [name, document] of [
      ['README', readme],
      ['landing page', landingPage],
      ['public docs', publicDocs],
      ['LLM index', llmsText],
      ['privacy', privacy],
      ['terms', terms],
      ['support', support],
      ['registry', registry],
      ['social image', ogImageSvg],
      ['changelog', changelog],
    ] as const) {
      for (const pattern of forbiddenSfLiveClaimPatterns) {
        expect(document, name).not.toMatch(pattern);
      }
    }

    expect(readme).toMatch(/18 MCP tools/i);
    expect(publicDocs).toMatch(/18 Model Context Protocol tools/i);
    expect(sfBayRollout).not.toMatch(/without registering public tools|on.*registers tools|current\.json\.gz/);
    expect(readme).toContain('docs/global-transit-verification.md');
    expect(sfBayRollout).toMatch(/SF Bay support is in development/i);
    expect(sfBayRollout).toContain('511 SF Bay');
    expect(privacy).toContain('511 SF Bay');
    expect(terms).toContain('511 SF Bay');
    expect(transitBoardSource).toContain('<title>Transit MCP Transit Board</title>');
    expect(ogImageSvg).toContain('SF Bay: in development');
    expect(ogImageSvg).toContain('2 live regions');
    expect([...wrangler.matchAll(/"SFBAY_MODE": "([^"]+)"/g)].map(match => match[1]))
      .toEqual(['dark', 'dark']);
  });

  it.each([
    'Live SF Bay arrivals and service alerts',
    'SF Bay transit is live',
  ])('recognizes a canonical SF Bay live claim: %s', claim => {
    expect(forbiddenSfLiveClaimPatterns.some(pattern => pattern.test(claim))).toBe(true);
  });

  it('links the landing page directly to the Claude Directory listing', () => {
    const directoryUrl = 'https://claude.ai/directory/metro-mcp';

    expect(landingPage).toMatch(
      new RegExp(`<a[^>]+href="${directoryUrl}"[^>]+aria-label="Open Transit MCP in the Claude Directory"`, 'i'),
    );
    expect(landingPage).not.toContain('href="https://claude.com"');
  });

  it('documents Transit MCP 6.0 as anonymous with no credential setup', () => {
    for (const [name, document, endpoint] of [
      ['README', readme, 'https://transitmcp.com/mcp'],
      ['security guide', securityGuide, 'https://transitmcp.com/mcp'],
      // Verification records capture evidence gathered against the original domain.
      ['protocol verification', protocolVerification, 'https://metro-mcp.anuragd.me/mcp'],
      ['Apps verification', appsVerification, 'https://metro-mcp.anuragd.me/mcp'],
      ['landing page', landingPage, 'https://transitmcp.com/mcp'],
      ['public docs', publicDocs, 'https://transitmcp.com/mcp'],
    ] as const) {
      expect(document, name).toContain(endpoint);
      expect(document, name).toMatch(/(?:no login is required|requires no login)/i);
      expect(document, name).toMatch(/no [^.\n]*OAuth flow is required/i);
      expect(document, name).not.toMatch(/GitHub OAuth App|MCP_CONFORMANCE_TOKEN|conformance-auth-proxy/i);
    }

    expect(readme).toMatch(/stale `?Authorization`? headers are ignored/i);
    expect(securityGuide).toMatch(/stale `?Authorization`? headers are ignored/i);
  });

  it('documents one eventually consistent Cloudflare rate-limit policy', () => {
    for (const document of [readme, securityGuide, changelog, publicDocs]) {
      expect(document).toMatch(/roughly 300 requests per 60-second window per source-IP key per Cloudflare location/i);
      expect(document).toMatch(/shared egress/i);
      expect(document).toMatch(/eventually consistent/i);
      expect(document).not.toMatch(/60 requests per (?:minute|shared source IP)/i);
    }
  });

  it('documents only the stateless /sse alias and active Cloudflare runtime', () => {
    expect(publicDocs).toMatch(/<span class="method">POST\/OPTIONS<\/span><code>\/sse<\/code>/);
    expect(publicDocs).toMatch(/stateless alias/i);
    expect(publicDocs).toMatch(/GET[^.]*`?405`?/i);
    expect(publicDocs).not.toMatch(/GET\/POST<\/span><code>\/sse|stateful|resume conversations|live sessions/i);
    expect(publicDocs).toMatch(/request-scoped stateless runtime/i);
    expect(publicDocs).toMatch(/does not support resumability or server push/i);
    expect(publicDocs).toMatch(/Cloudflare Rate Limit binding/i);
    expect(publicDocs).toMatch(/inactive <code>MetroMcpAgent<\/code> rollback class and <code>v1<\/code> migration/i);
  });

  it('documents anonymous method-bound MRTR and the exact telemetry inventory', () => {
    expect(securityGuide).toMatch(/no caller identity/i);
    expect(securityGuide).toMatch(/MCP method plus validated operation payload/i);
    expect(securityGuide).not.toMatch(/binds the user|cross-user replay/i);
    expect(securityGuide).toMatch(/authentication is absent by design/i);
    expect(securityGuide).not.toMatch(/authentication is required/i);
    expect(securityGuide).toMatch(/`Mcp-Method` and `Mcp-Name` are untrusted request headers at the edge/i);
    expect(securityGuide).toMatch(/edge rule must validate and allowlist any secondary dimension itself/i);
    expect(securityGuide).toMatch(/key primarily on trusted Cloudflare identity or source IP/i);
    expect(securityGuide).toMatch(/never treat a header as identity/i);

    const telemetryFields = [
      'era', 'protocolVersion', 'mcpMethod', 'mcpName',
      'clientName', 'alias', 'upstream', 'durationMs', 'statusClass',
    ];
    for (const field of telemetryFields) expect(securityGuide).toContain(`\`${field}\``);
    expect(securityGuide).not.toMatch(/clientId|authentication detail/i);
  });

  it('keeps the 6.0 rollback window and active SDK input boundaries accurate', () => {
    expect(securityGuide).toMatch(/6\.0 stabilization and rollback window/i);
    expect(securityGuide).not.toMatch(/5\.0 stabilization window/i);
    expect(securityGuide).not.toMatch(
      /\b(?:validateToolParams|ValidationError|validateCityCode|validateSearchQuery|validateQuery)\b/,
    );
    expect(securityGuide).not.toMatch(
      /Remove dangerous characters|Max length: 100|Strict validation prevents path traversal/,
    );
    expect(securityGuide).toMatch(/JSON Schema[^.]*Zod/i);
    expect(securityGuide).toMatch(/not universally sanitized/i);
    expect(securityGuide).toMatch(/no generic regex or maximum-length constraint/i);
    expect(securityGuide).toMatch(/path and query values[^.]*encoded/i);
    expect(securityGuide).toMatch(/structured JSON and text[^.]*not rendered as trusted HTML/i);
    expect(securityGuide).toMatch(/thrown WMATA failures[^.]*mapped to operational tool errors/i);
    expect(securityGuide).toMatch(/MTA prediction-feed failures[^.]*partial or empty/i);
    expect(securityGuide).toMatch(/MTA incident-feed failures[^.]*empty incidents/i);
    expect(securityGuide).toMatch(/Abort failures rethrow/i);
  });

  it('documents the thirteen-tool Apps enhancement and reproducible browser boundary', () => {
    expect(readme).toContain('docs/mcp-apps-verification.md');
    expect(appsVerification).toMatch(/Apps-capable host/i);
    expect(appsVerification).toMatch(/text fallback/i);
    expect(appsVerification).toMatch(/Codex[^.]*fallback/i);
    expect(appsVerification).toContain('bun run build:apps');
    expect(appsVerification).toContain('bun run test:apps');
    expect(appsVerification).toContain('git diff --exit-code -- public/apps/transit-board.html');
    expect(appsVerification).toContain('git diff --check origin/main...HEAD');
    expect(appsVerification).toMatch(/publicly readable[^.]*inert/i);
    expect(appsVerification).toMatch(/no direct (?:browser )?network/i);
    expect(appsVerification).toMatch(/no (?:browser )?storage/i);
    expect(appsVerification).toMatch(/no (?:browser )?permissions/i);
    for (const toolName of [
      'get_station_predictions', 'search_stations', 'get_stations_by_line',
      'get_incidents', 'get_elevator_incidents', 'get_all_stations',
      'get_bus_predictions', 'get_bus_routes', 'get_bus_stops',
      'get_bus_positions', 'get_train_positions', 'get_station_transfers', 'get_route_info',
    ]) expect(appsVerification).toContain(`\`${toolName}\``);
    for (const policy of [
      'secrets', 'innerHTML', 'external URLs/assets', 'fetch/XHR/WebSocket/EventSource',
      'storage/permission APIs', 'new Wrangler bindings', 'package-lock files',
      'v1 server imports', 'account-flow or legacy-route changes',
    ]) expect(appsVerification).toContain(policy);
  });

  it('pins the browser runner and defines a sandboxed official-protocol host', () => {
    expect(packageJson.devDependencies['@playwright/test']).toBe('1.62.1');
    expect(packageJson.scripts['test:apps']).toBe('playwright test --config playwright.apps.config.ts');
    expect(workflow.indexOf('bunx playwright install --with-deps chromium'))
      .toBeGreaterThan(workflow.indexOf('git diff --exit-code -- public/apps/transit-board.html'));
    expect(workflow.indexOf('bun run test:apps'))
      .toBeGreaterThan(workflow.indexOf('bunx playwright install --with-deps chromium'));
    expect(workflow.indexOf('node node_modules/wrangler/bin/wrangler.js deploy --dry-run'))
      .toBeGreaterThan(workflow.indexOf('bun run test:apps'));
    expect(appsHostHtml).toMatch(
      /<iframe[^>]+id="app-frame"[^>]+sandbox="allow-scripts"[^>]+data-resource="\/apps\/transit-board\.html"/,
    );
    expect(appsHostSource).toMatch(/from ['"]@modelcontextprotocol\/ext-apps\/app-bridge['"]/);
    expect(appsHostSource).toContain('new AppBridge(');
    expect(appsHostSource).toContain('new PostMessageTransport(');
    expect(appsHostSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
    for (const name of ['WMATA_API_KEY', 'OAuth']) expect(appsHostSource).not.toContain(name);
  });
});
