import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4178';

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
    viewport: { width: 1_280, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bunx vite --host 127.0.0.1 --port 4178 --strictPort',
    url: `${baseURL}/@vite/client`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
