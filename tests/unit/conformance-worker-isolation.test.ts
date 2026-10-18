import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('actual Workers config ignores adjacent checkout .dev.vars and uses the isolated local bindings', async () => {
  const { start, stop } = await import('../../scripts/run-conformance.mjs');
  const source = resolve('.');
  const directory = mkdtempSync(join(tmpdir(), 'transit-worker-isolation-'));
  const checkout = join(directory, 'checkout'), isolated = join(directory, 'isolated');
  mkdirSync(join(checkout, 'tests/workers'), { recursive: true });
  mkdirSync(isolated);
  for (const entry of ['node_modules', 'src', 'public']) symlinkSync(join(source, entry), join(checkout, entry));
  copyFileSync(join(source, 'vitest.workers.config.ts'), join(checkout, 'vitest.workers.config.ts'));
  copyFileSync(join(source, 'wrangler.jsonc'), join(checkout, 'wrangler.jsonc'));
  writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
  writeFileSync(join(checkout, '.dev.vars'), 'SF511_API_KEY=synthetic-checkout-canary\nCONFORMANCE_CHECKOUT_CANARY=synthetic-only\n');
  writeFileSync(join(isolated, '.dev.vars'), 'LOCAL_ONLY_MARKER=isolated-runtime\n');
  writeFileSync(join(isolated, 'wrangler.json'), JSON.stringify({
    name: 'isolated-evidence-test', main: join(source, 'src/index.ts'), compatibility_date: '2026-04-07',
    compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    vars: { SFBAY_MODE: 'off' },
    durable_objects: { bindings: [{ name: 'REGION_FEED_HUB', class_name: 'RegionFeedHub' }] },
    migrations: [{ tag: 'local', new_sqlite_classes: ['RegionFeedHub'] }],
    r2_buckets: [{ binding: 'TRANSIT_ARTIFACTS', bucket_name: 'local-only' }],
    assets: { directory: join(source, 'public'), binding: 'ASSETS' },
  }));
  writeFileSync(join(checkout, 'tests/workers/isolation.test.ts'), `
    import { env } from 'cloudflare:workers';
    import { SELF } from 'cloudflare:test';
    import { expect, it } from 'vitest';
    it('runs the real Worker with only isolated bindings', async () => {
      expect('CONFORMANCE_CHECKOUT_CANARY' in env).toBe(false);
      expect('SF511_API_KEY' in env).toBe(false);
      expect('ANALYTICS' in env).toBe(false);
      expect(env.LOCAL_ONLY_MARKER).toBe('isolated-runtime');
      expect(env.SFBAY_MODE).toBe('off');
      expect(env.WMATA_API_KEY).toBe('test-wmata-api-key');
      expect(env.MCP_REQUEST_STATE_KEY).toBe('test-mrtr-request-state-key-32-bytes-minimum');
      expect(typeof env.REGION_FEED_HUB.idFromName).toBe('function');
      await env.TRANSIT_ARTIFACTS.put('isolation-proof', 'public-local-fixture');
      expect(await (await env.TRANSIT_ARTIFACTS.get('isolation-proof')).text()).toBe('public-local-fixture');
      const response = await SELF.fetch('https://transitmcp.com/info');
      expect(response.status).toBe(200);
      expect((await response.json()).name).toBe('Transit MCP');
    });
  `);
  const log = await open(join(directory, 'vitest.log'), 'w');
  const output = join(directory, 'result.json');
  const child = start([join(source, 'node_modules/vitest/vitest.mjs'), 'run', '--root', checkout,
    '--config', join(checkout, 'vitest.workers.config.ts'), '--reporter=json', '--outputFile', output], checkout, log,
    { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, NO_COLOR: '1',
      WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
      WRANGLER_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', MCP_CONFORMANCE_WRANGLER_CONFIG: join(isolated, 'wrangler.json') });
  const deadline = setTimeout(() => { void stop(child).catch(() => {}); }, 20_000);
  try {
    const status = await child.done;
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.testResults.flatMap((file: { assertionResults: Array<{ failureMessages: string[] }> }) => file.assertionResults.flatMap(test => test.failureMessages))).toEqual([]);
    expect(status).toBe(0);
    expect(report).toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0 });
    expect(readFileSync(join(checkout, '.dev.vars'), 'utf8')).toContain('synthetic-checkout-canary');
  } finally {
    clearTimeout(deadline);
    await stop(child);
    await log.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
