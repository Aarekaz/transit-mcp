import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('MCP dependency policy', () => {
  it('pins the mutually compatible MCP stack exactly', () => {
    expect(pkg.dependencies).toMatchObject({
      agents: '0.20.1',
      '@modelcontextprotocol/server': '2.0.0',
      '@modelcontextprotocol/client': '2.0.0',
      '@modelcontextprotocol/sdk': '1.30.0',
      '@cloudflare/workers-oauth-provider': '0.10.3',
      zod: '4.4.3'
    });
    expect(pkg.devDependencies['@modelcontextprotocol/conformance'])
      .toBe('0.2.0-alpha.11');
  });
});
