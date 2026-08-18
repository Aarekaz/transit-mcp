import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      kvNamespaces: ['OAUTH_KV'],
      bindings: {
        MCP_PUBLIC_ORIGIN: 'https://metro-mcp.anuragd.me',
        MCP_ALLOWED_HOSTNAMES: 'metro-mcp.anuragd.me',
        MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp.anuragd.me',
        MCP_REQUEST_STATE_KEY: 'test-mrtr-request-state-key-32-bytes-minimum',
        GITHUB_CLIENT_ID: 'test-github-client-id',
        GITHUB_CLIENT_SECRET: 'test-github-client-secret',
        OAUTH_REDIRECT_URI: 'https://metro-mcp.anuragd.me/callback',
        WMATA_API_KEY: 'test-wmata-api-key',
        JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
        ENVIRONMENT: 'production',
      },
    },
  })],
  test: { include: ['tests/workers/**/*.test.ts'] }
});
