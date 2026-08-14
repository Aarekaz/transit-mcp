import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../../README.md', import.meta.url).pathname, 'utf8');

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
});
