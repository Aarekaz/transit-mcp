import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      ratelimits: {
        MCP_RATE_LIMITER: {
          simple: { limit: 2, period: 10 },
        },
      },
      bindings: {
        MCP_PUBLIC_ORIGIN: 'https://metro-mcp.anuragd.me',
        MCP_ALLOWED_HOSTNAMES: 'metro-mcp.anuragd.me',
        MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp.anuragd.me',
        MCP_REQUEST_STATE_KEY: 'test-mrtr-request-state-key-32-bytes-minimum',
        WMATA_API_KEY: 'test-wmata-api-key',
        ENVIRONMENT: 'production',
      },
    },
  })],
  test: { include: ['tests/workers/**/*.test.ts'] }
});
