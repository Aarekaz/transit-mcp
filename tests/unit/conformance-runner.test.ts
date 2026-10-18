import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import type { Env } from '../../src/types';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'transit-conformance-test-'));
  roots.push(root);
  const write = (path: string, source: string) => { const file = join(root, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, source); };
  write('node_modules/@modelcontextprotocol/conformance/package.json', JSON.stringify({ version: '0.2.0-alpha.11' }));
  write('node_modules/@modelcontextprotocol/conformance/requirements/2026-07-28.yaml', 'server:\n  - tools-list\nclient:\nnot_scored:\n  - scenario: tasks-lifecycle\n    leg: server\n    reason: extension\n');
  write('scripts/mcp-conformance-profile.json', JSON.stringify({ profile: 'transit-mcp-2026-07-28-v1', revision: '2026-07-28', refereeVersion: '0.2.0-alpha.11',
    requirementsSha256: createHash('sha256').update(readFileSync(join(root, 'node_modules/@modelcontextprotocol/conformance/requirements/2026-07-28.yaml'))).digest('hex'),
    evidence: { real: { file: 'tests/real.test.ts', title: 'real contract' } }, diagnosticChecks: [] }));
  write('node_modules/vitest/vitest.mjs', `import fs from 'node:fs'; fs.writeFileSync(process.argv[process.argv.indexOf('--outputFile')+1], JSON.stringify({ success: true, numTotalTests: 1, testResults: [{ name: ${JSON.stringify(join(root, 'tests/real.test.ts'))}, assertionResults: [{ title: 'real contract', status: 'passed' }] }] }));`);
  write('.dev.vars', 'SF511_API_KEY=private-canary\n');
  write('node_modules/wrangler/bin/wrangler.js', `
    const fs = require('node:fs'), http = require('node:http');
    const args = process.argv.slice(2), config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1]));
    if (args[0] !== 'dev' || !args.includes('--local') || config.triggers || config.routes || config.analytics_engine_datasets) process.exit(33);
    if (process.env.SF511_API_KEY || process.env.CLOUDFLARE_API_TOKEN || process.env.MCP_CONFORMANCE_TOKEN) process.exit(34);
    fs.writeFileSync(${JSON.stringify(join(root, 'worker-pid'))}, String(process.pid));
    http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: 'Transit MCP', protocolVersion: '2026-07-28' })); }).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
  `);
  write('node_modules/@modelcontextprotocol/conformance/dist/index.js', `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    if (!args.includes('--requirements') || args[args.indexOf('--requirements')+1] !== '2026-07-28') process.exit(35);
    if (args[0] === 'server') {
      fetch(args[args.indexOf('--url')+1].replace('/mcp','/info')).then(async r => {
        if (!(await r.json()).name) process.exit(36);
        const output = args[args.indexOf('--output-dir') + 1];
        for (const [name, status] of [['tools-list', ${JSON.stringify(exitCode ? 'FAILURE' : 'SUCCESS')}], ['tasks-lifecycle', 'FAILURE']]) {
          const p = path.join(output, 'server-' + name + '-2026-10-18T00-00-00-000Z');
          fs.mkdirSync(p, { recursive: true });
          fs.writeFileSync(path.join(p, 'checks.json'), JSON.stringify([{ id: 'check', status, errorMessage: 'private-canary' }]));
        }
        console.log('Required conformance: fixture result; optional extensions reported separately');
        process.exit(${exitCode});
      });
    }
  `);
  return root;
}

describe('managed local conformance runner', () => {
  it('has valid Bash syntax', () => {
    expect(spawnSync('bash', ['-n', 'scripts/run-conformance.sh']).status).toBe(0);
  });

  it.each([0, 23])('starts an isolated Worker, preserves official exit %s, and terminates only its child', async code => {
    const runner = await import('../../scripts/run-conformance.mjs').catch(() => undefined);
    expect(runner, 'a managed runner must start the local Worker').toBeDefined();
    vi.stubEnv('SF511_API_KEY', 'private-canary');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'private-canary');
    const root = fixture(code);
    const result = await runner!.runConformance(root);
    roots.push(result.directory);
    expect(result.officialExitCode).toBe(code);
    expect(result.exitCode).toBe(code ? 1 : 0);
    expect(result).toHaveProperty('summary.required');
    expect(result.summary.required).toMatchObject({ scenarios: 1, passed: code ? 0 : 1, failed: code ? 1 : 0 });
    expect(result.summary.notScored.extension).toMatchObject({ scenarios: 1, passed: 0, failed: 1 });
    expect(JSON.stringify(result.summary)).not.toContain('private-canary');
    expect(existsSync(join(result.directory, 'requirements.txt'))).toBe(true);
    expect(readFileSync(join(root, '.dev.vars'), 'utf8')).toContain('private-canary');
    expect(readFileSync(join(result.directory, 'conformance.log'), 'utf8')).not.toContain('private-canary');
    const pid = Number(readFileSync(join(root, 'worker-pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    const config = JSON.parse(readFileSync(join(result.directory, 'wrangler.json'), 'utf8'));
    expect(config.vars.SFBAY_MODE).toBe('off');
    expect(config.vars.TRANSIT_COVERAGE_MODES).toBe('{"dc":"off","nyc":"off","sfbay":"off"}');
    const localValues = Object.fromEntries(readFileSync(join(result.directory, '.dev.vars'), 'utf8').trim().split('\n').map(line => line.split('=')));
    expect(() => loadConfig({ ...config.vars, ...localValues } as Env)).not.toThrow();
  });

  it('refuses a different referee version before starting a Worker', async () => {
    const runner = await import('../../scripts/run-conformance.mjs').catch(() => undefined);
    expect(runner).toBeDefined();
    const root = fixture();
    writeFileSync(join(root, 'node_modules/@modelcontextprotocol/conformance/package.json'), '{"version":"latest"}');
    await expect(runner!.runConformance(root)).rejects.toThrow(/pinned/);
    expect(existsSync(join(root, 'worker-pid'))).toBe(false);
  });

  it('fails closed on missing, malformed and skipped required reports', async () => {
    const { summarizeConformance } = await import('../../scripts/run-conformance.mjs');
    const root = fixture();
    const requirements = readFileSync(join(root, 'node_modules/@modelcontextprotocol/conformance/requirements/2026-07-28.yaml'), 'utf8');
    expect((await summarizeConformance(root, requirements)).required.missing).toBe(1);
    const directory = join(root, 'server-tools-list-2026-10-18T00-00-00-000Z');
    mkdirSync(directory);
    for (const contents of ['not JSON', '[]', '[{"status":"UNKNOWN"}]']) {
      writeFileSync(join(directory, 'checks.json'), contents);
      expect(await summarizeConformance(root, requirements)).toMatchObject({ passed: false, required: { missing: 1 } });
    }
    writeFileSync(join(directory, 'checks.json'), '[{"id":"tools-list","status":"SKIPPED"}]');
    expect(await summarizeConformance(root, requirements)).toMatchObject({ passed: false, required: { skipped: 1 } });
  });
});
