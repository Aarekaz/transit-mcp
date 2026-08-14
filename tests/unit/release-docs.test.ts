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
});
