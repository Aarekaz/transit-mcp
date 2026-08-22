import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url).pathname, 'utf8');

const activeDocuments = [
  ['README', readProjectFile('README.md')],
  ['security guide', readProjectFile('docs/SECURITY.md')],
  ['protocol verification', readProjectFile('docs/mcp-2026-verification.md')],
  ['Apps verification', readProjectFile('docs/mcp-apps-verification.md')],
  ['landing page', readProjectFile('public/index.html')],
  ['public docs', readProjectFile('public/docs/index.html')],
] as const;

describe('release operator documentation', () => {
  it('documents Metro MCP 6.0 as anonymous with no credential setup', () => {
    for (const [name, document] of activeDocuments) {
      expect(document, name).toContain('https://metro-mcp.anuragd.me/mcp');
      expect(document, name).toMatch(/(?:no login is required|requires no login)/i);
      expect(document, name).toMatch(/no [^.\n]*OAuth flow is required/i);
      expect(document, name).not.toMatch(/GitHub OAuth App|MCP_CONFORMANCE_TOKEN|conformance-auth-proxy/i);
    }

    const readme = activeDocuments[0][1];
    const securityGuide = activeDocuments[1][1];
    expect(readme).toMatch(/stale `?Authorization`? headers are ignored/i);
    expect(securityGuide).toMatch(/stale `?Authorization`? headers are ignored/i);
  });

  it('states the shared-IP Cloudflare limits as approximate', () => {
    const securityGuide = activeDocuments[1][1];
    expect(securityGuide).toMatch(/approximately 300 requests per minute per Cloudflare location/i);
    expect(securityGuide).toMatch(/approximately 60 requests per minute per shared source IP/i);
    expect(securityGuide).toMatch(/not a guarantee of a dedicated user quota/i);
  });

  it('preserves the advertised 13 tools, three resources, three prompts, and Apps fallback', () => {
    const readme = activeDocuments[0][1];
    const appsVerification = activeDocuments[3][1];
    expect(readme).toMatch(/13 MCP tools/i);
    expect(readme).toMatch(/three `transit:\/\/` URI templates/i);
    expect(readme).toMatch(/three canned templates/i);
    expect(appsVerification).toMatch(/Apps-capable host/i);
    expect(appsVerification).toMatch(/text fallback/i);

    for (const toolName of [
      'get_station_predictions', 'search_stations', 'get_stations_by_line',
      'get_incidents', 'get_elevator_incidents', 'get_all_stations',
      'get_bus_predictions', 'get_bus_routes', 'get_bus_stops',
      'get_bus_positions', 'get_train_positions', 'get_station_transfers', 'get_route_info',
    ]) {
      expect(appsVerification).toContain(`\`${toolName}\``);
    }
  });

  it('documents the current runtime trust, cancellation, cache, MRTR, and rollback boundaries', () => {
    const readme = activeDocuments[0][1];
    const securityGuide = activeDocuments[1][1];
    expect(readme).toMatch(/Cloudflare Workers/i);
    expect(readme).toMatch(/request cancellation/i);
    expect(readme).toMatch(/MRTR/i);
    expect(readme).toMatch(/cache/i);
    expect(readme).toMatch(/rollback/i);
    expect(securityGuide).toMatch(/trusted Cloudflare identity or source IP/i);
    expect(securityGuide).toMatch(/structured JSON and text[^.]*not rendered as trusted HTML/i);
  });
});
