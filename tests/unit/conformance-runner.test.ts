import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const runner = new URL('../../scripts/run-conformance.sh', import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runWith(overrides: NodeJS.ProcessEnv) {
  return spawnSync('bash', [runner], {
    cwd: new URL('../..', import.meta.url).pathname,
    encoding: 'utf8',
    env: { ...process.env, ...overrides },
  });
}

describe('conformance runner', () => {
  it('has valid Bash syntax', () => {
    expect(spawnSync('bash', ['-n', runner]).status).toBe(0);
  });

  it('requires only the target without echoing unrelated environment values', () => {
    const token = 'runner-token-that-must-not-escape';
    const result = runWith({
      MCP_CONFORMANCE_TARGET_URL: '',
      MCP_CONFORMANCE_TOKEN: token,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('MCP_CONFORMANCE_TARGET_URL');
    expect(output).not.toContain(token);
  });

  it('runs the frozen requirements directly against the supplied target', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'metro-mcp-conformance-runner-'));
    temporaryRoots.push(fakeBin);
    const callsFile = join(fakeBin, 'bunx-calls');

    writeExecutable(fakeBin, 'bunx', `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_BUNX_CALLS"
if [[ "$2" == 'server' ]]; then exit 23; fi
`);

    const result = runWith({
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      MCP_CONFORMANCE_TARGET_URL: 'http://127.0.0.1:8787/mcp',
      MCP_CONFORMANCE_TOKEN: 'runner-lifecycle-probe',
      FAKE_BUNX_CALLS: callsFile,
    });

    expect(result.status).toBe(23);
    expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual([
      '@modelcontextprotocol/conformance list --requirements 2026-07-28',
      '@modelcontextprotocol/conformance server --url http://127.0.0.1:8787/mcp --requirements 2026-07-28',
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain('runner-lifecycle-probe');
  });

  it('has no proxy or credential behavior', () => {
    const source = readFileSync(runner, 'utf8');

    expect(source).not.toMatch(/MCP_CONFORMANCE_TOKEN|proxy|curl|\bbun scripts\//i);
  });
});

function writeExecutable(directory: string, name: string, source: string): void {
  const file = join(directory, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}
