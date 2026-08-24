import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = 'http://127.0.0.1:4178';
const workerStateDirectory = join(tmpdir(), 'metro-mcp-playwright-worker-state');

export default defineConfig({
  testDir: './tests/apps',
  testMatch: ['transit-board.spec.ts', 'legal-pages.spec.ts'],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: 'output/playwright/test-results',
  reporter: [['line']],
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1_280, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'bunx vite --host 127.0.0.1 --port 4178 --strictPort',
      url: `${baseURL}/@vite/client`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: [
        'bunx wrangler dev --local --ip 127.0.0.1 --port 4179',
        `--persist-to ${JSON.stringify(workerStateDirectory)}`,
        '--var MCP_PUBLIC_ORIGIN:http://127.0.0.1:4179',
        '--var MCP_ALLOWED_HOSTNAMES:127.0.0.1',
        '--var MCP_ALLOWED_ORIGIN_HOSTNAMES:127.0.0.1',
        '--var MCP_REQUEST_STATE_KEY:playwright-local-placeholder-key-000000',
        '--var WMATA_API_KEY:playwright-local-placeholder',
        '--var ENVIRONMENT:development',
      ].join(' '),
      url: 'http://127.0.0.1:4179/info',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
