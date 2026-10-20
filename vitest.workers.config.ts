import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    // Conformance supplies its fresh local-only config. In particular, do not
    // resolve the checkout config (and adjacent .dev.vars) for mapped evidence.
    wrangler: { configPath: process.env.MCP_CONFORMANCE_WRANGLER_CONFIG ?? './wrangler.jsonc' },
    miniflare: {
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      ratelimits: {
        MCP_RATE_LIMITER: {
          simple: { limit: 2, period: 10 },
        },
      },
      bindings: {
        MCP_PUBLIC_ORIGIN: 'https://transitmcp.com',
        MCP_ALLOWED_HOSTNAMES: 'transitmcp.com,metro-mcp.anuragd.me',
        MCP_ALLOWED_ORIGIN_HOSTNAMES: 'transitmcp.com,metro-mcp.anuragd.me',
        MCP_REQUEST_STATE_KEY: 'test-mrtr-request-state-key-32-bytes-minimum',
        WMATA_API_KEY: 'test-wmata-api-key',
        // The assembled-Worker suite exercises the SF planner on synthetic data, which a
        // deployment may withhold (TRANSIT_PLANNING_OFF); keep it searchable here.
        TRANSIT_PLANNING_OFF: '[]',
        ENVIRONMENT: 'production',
      },
    },
  })],
  test: { include: ['tests/workers/**/*.test.ts'] }
});
