import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../../README.md', import.meta.url).pathname, 'utf8');
const securityGuide = readFileSync(
  new URL('../../docs/SECURITY.md', import.meta.url).pathname,
  'utf8',
);
const readOptionalProjectFile = (path: string): string => {
  const file = new URL(`../../${path}`, import.meta.url).pathname;
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const appsVerification = readOptionalProjectFile('docs/mcp-apps-verification.md');
const appsHostHtml = readOptionalProjectFile('tests/apps/host.html');
const appsHostSource = readOptionalProjectFile('tests/apps/host.ts');
const packageJson = JSON.parse(readOptionalProjectFile('package.json')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const workflow = readOptionalProjectFile('.github/workflows/type-check.yml');

describe('release operator documentation', () => {
  it('shows every required preview secret command with the named environment', () => {
    for (const secret of [
      'MCP_REQUEST_STATE_KEY',
      ['GITHUB', 'CLIENT_SECRET'].join('_'),
      'WMATA_API_KEY',
      ['JWT', 'SECRET'].join('_'),
    ]) {
      expect(readme).toContain(`bunx wrangler secret put ${secret} --env preview`);
    }
  });

  it('states the active SDK v2 input boundaries without removed validator claims', () => {
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
  });

  it('documents the distinct WMATA and MTA upstream failure contracts', () => {
    expect(securityGuide).not.toMatch(
      /Upstream transit clients map provider\/network failures into operational tool errors/i,
    );
    expect(securityGuide).toMatch(/thrown WMATA failures[^.]*mapped to operational tool errors/i);
    expect(securityGuide).toMatch(/MTA prediction-feed failures[^.]*partial or empty/i);
    expect(securityGuide).toMatch(/MTA incident-feed failures[^.]*empty incidents/i);
    expect(securityGuide).toMatch(/Abort failures rethrow/i);
  });

  it('documents the active OAuth HTML boundary', () => {
    expect(securityGuide).not.toMatch(
      /script-src 'self' 'unsafe-inline'|inline scripts|Log full error|console\.error/i,
    );
    expect(securityGuide).toMatch(/server-rendered[^.]*escaped[^.]*no scripts/i);
    expect(securityGuide).toContain(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(securityGuide).toMatch(/Referrer-Policy[^.]*no-referrer/i);
  });

  it('distinguishes Metro telemetry from pinned Provider diagnostics', () => {
    expect(securityGuide).not.toMatch(
      /Application telemetry is structured and restricted to allowlisted fields/i,
    );
    expect(securityGuide).not.toMatch(/Structured telemetry is limited to allowlisted fields/i);
    expect(securityGuide).toMatch(/Metro application telemetry[^.]*allowlisted fields/i);
    expect(securityGuide).toMatch(/Provider 0\.10\.3[^.]*outside[^.]*Metro serializer/i);
    expect(securityGuide).toMatch(
      /OAuth and CIMD diagnostics[^.]*client or metadata URL[^.]*upstream error detail/i,
    );
    expect(securityGuide).toMatch(
      /reviewed Provider paths[^.]*no known bearer credentials, client secrets, or tokens/i,
    );
    expect(securityGuide).toMatch(/Worker log and tail access[^.]*sensitive/i);
    expect(securityGuide).toMatch(/restrict access[^.]*limit retention[^.]*redact downstream/i);
  });

  it('treats MCP edge dimensions as untrusted request headers', () => {
    expect(securityGuide).not.toMatch(
      /Rules may use validated `Mcp-Method` and `Mcp-Name` as dimensions/i,
    );
    expect(securityGuide).toMatch(
      /`Mcp-Method` and `Mcp-Name` are untrusted request headers at the edge/i,
    );
    expect(securityGuide).toMatch(/edge rule[^.]*validate and allowlist[^.]*itself/i);
    expect(securityGuide).toMatch(
      /key primarily on trusted Cloudflare identity or source IP/i,
    );
    expect(securityGuide).toMatch(/never treat[^.]*authenticated identity/i);
  });

  it('limits the 90-day client TTL claim to dynamic registration', () => {
    expect(securityGuide).not.toMatch(/(?:^|\n)Registered clients expire after 90 days/mi);
    expect(securityGuide).toMatch(/Dynamically registered clients expire after 90 days/i);
    expect(securityGuide).toMatch(
      /pre-registered configured clients[^.]*not governed by the DCR TTL[^.]*persist until revoked or removed/i,
    );
    expect(securityGuide).toMatch(/CIMD[^.]*resolved metadata[^.]*not a stored DCR record/i);
  });

  it('documents the thirteen-tool Apps enhancement and its fallback boundary', () => {
    expect(readme).toContain('docs/mcp-apps-verification.md');
    expect(appsVerification).toMatch(/Apps-capable host/i);
    expect(appsVerification).toMatch(/text fallback/i);
    expect(appsVerification).toMatch(/Codex[^.]*fallback/i);

    for (const toolName of [
      'get_station_predictions',
      'search_stations',
      'get_stations_by_line',
      'get_all_stations',
      'get_station_transfers',
      'get_incidents',
      'get_elevator_incidents',
      'get_bus_predictions',
      'get_bus_routes',
      'get_bus_stops',
      'get_bus_positions',
      'get_train_positions',
      'get_route_info',
    ]) {
      expect(appsVerification).toContain(`\`${toolName}\``);
    }
  });

  it('documents reproducible browser verification and the inert public bundle boundary', () => {
    expect(appsVerification).toContain('bun run build:apps');
    expect(appsVerification).toContain('bun run test:apps');
    expect(appsVerification).toContain(
      'git diff --exit-code -- public/apps/transit-board.html',
    );
    expect(appsVerification).toContain('git diff --check origin/main...HEAD');
    expect(appsVerification).toContain('public/apps/transit-board.html');
    expect(appsVerification).toMatch(/publicly readable[^.]*inert/i);
    expect(appsVerification).toMatch(/no direct (?:browser )?network/i);
    expect(appsVerification).toMatch(/no (?:browser )?storage/i);
    expect(appsVerification).toMatch(/no (?:browser )?permissions/i);
    for (const policy of [
      'secrets',
      'innerHTML',
      'external URLs/assets',
      'fetch/XHR/WebSocket/EventSource',
      'storage/permission APIs',
      'new Wrangler bindings',
      'package-lock files',
      'v1 server imports',
      'OAuth/legacy-route changes',
    ]) {
      expect(appsVerification).toContain(policy);
    }
  });

  it('pins the browser runner and places the Chromium gate before the Worker dry-run', () => {
    expect(packageJson.devDependencies['@playwright/test']).toBe('1.62.1');
    expect(packageJson.scripts['test:apps']).toBe(
      'playwright test --config playwright.apps.config.ts',
    );

    const artifactCheck = workflow.indexOf(
      'git diff --exit-code -- public/apps/transit-board.html',
    );
    const browserInstall = workflow.indexOf(
      'bunx playwright install --with-deps chromium',
    );
    const browserTest = workflow.indexOf('bun run test:apps');
    const workerDryRun = workflow.indexOf('bunx wrangler deploy --dry-run');
    expect(browserInstall).toBeGreaterThan(artifactCheck);
    expect(browserTest).toBeGreaterThan(browserInstall);
    expect(workerDryRun).toBeGreaterThan(browserTest);
  });

  it('defines a sandboxed official-protocol host with no live provider or OAuth boundary', () => {
    expect(appsHostHtml).toMatch(
      /<iframe[^>]+id="app-frame"[^>]+sandbox="allow-scripts"[^>]+data-resource="\/apps\/transit-board\.html"/,
    );
    expect(appsHostSource).toMatch(
      /from ['"]@modelcontextprotocol\/ext-apps\/app-bridge['"]/,
    );
    expect(appsHostSource).toContain('new AppBridge(');
    expect(appsHostSource).toContain('new PostMessageTransport(');
    expect(appsHostSource).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
    const privateRuntimeNames = [
      'WMATA_API_KEY',
      ['GITHUB', 'CLIENT_SECRET'].join('_'),
      ['JWT', 'SECRET'].join('_'),
      ['O', 'Auth'].join(''),
    ];
    for (const name of privateRuntimeNames) expect(appsHostSource).not.toContain(name);
  });
});
