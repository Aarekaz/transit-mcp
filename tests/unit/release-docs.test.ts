import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../../README.md', import.meta.url).pathname, 'utf8');
const securityGuide = readFileSync(
  new URL('../../docs/SECURITY.md', import.meta.url).pathname,
  'utf8',
);

describe('release operator documentation', () => {
  it('shows every required preview secret command with the named environment', () => {
    for (const secret of [
      'MCP_REQUEST_STATE_KEY',
      'GITHUB_CLIENT_SECRET',
      'WMATA_API_KEY',
      'JWT_SECRET',
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

  it('documents the active OAuth HTML and structured logging boundaries', () => {
    expect(securityGuide).not.toMatch(
      /script-src 'self' 'unsafe-inline'|inline scripts|Log full error|console\.error/i,
    );
    expect(securityGuide).toMatch(/server-rendered[^.]*escaped[^.]*no scripts/i);
    expect(securityGuide).toContain(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(securityGuide).toMatch(/Referrer-Policy[^.]*no-referrer/i);
    expect(securityGuide).toMatch(/structured[^.]*allowlisted fields/i);
    expect(securityGuide).toMatch(
      /Never log raw error objects, tokens, secrets, or user payloads/i,
    );
  });

  it('limits the 90-day client TTL claim to dynamic registration', () => {
    expect(securityGuide).not.toMatch(/(?:^|\n)Registered clients expire after 90 days/mi);
    expect(securityGuide).toMatch(/Dynamically registered clients expire after 90 days/i);
    expect(securityGuide).toMatch(
      /pre-registered configured clients[^.]*not governed by the DCR TTL[^.]*persist until revoked or removed/i,
    );
    expect(securityGuide).toMatch(/CIMD[^.]*resolved metadata[^.]*not a stored DCR record/i);
  });
});
