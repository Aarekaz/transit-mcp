import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4178';
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './tests/apps',
  testMatch: 'transit-board.spec.ts',
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
    channel: !process.env.CI && existsSync(localChrome) ? 'chrome' : undefined,
    viewport: { width: 1_280, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bunx vite --host 127.0.0.1 --port 4178 --strictPort',
    url: `${baseURL}/@vite/client`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
