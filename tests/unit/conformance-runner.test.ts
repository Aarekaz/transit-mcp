import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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

  it('fails before startup when the target is missing without echoing the token', () => {
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

  it('fails before startup when the token is missing', () => {
    const result = runWith({
      MCP_CONFORMANCE_TARGET_URL: 'http://127.0.0.1:8787/mcp',
      MCP_CONFORMANCE_TOKEN: '',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('MCP_CONFORMANCE_TOKEN');
  });

  it('pins the frozen requirements and cleans up the proxy when conformance exits', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'metro-mcp-conformance-runner-'));
    temporaryRoots.push(fakeBin);
    const stoppedFile = join(fakeBin, 'proxy-stopped');
    const callsFile = join(fakeBin, 'bunx-calls');

    writeExecutable(fakeBin, 'bun', `#!/usr/bin/env bash
trap 'printf stopped > "$FAKE_PROXY_STOPPED"; exit 0' TERM INT
while :; do sleep 0.1; done
`);
    writeExecutable(fakeBin, 'curl', '#!/usr/bin/env bash\nexit 0\n');
    writeExecutable(fakeBin, 'bunx', `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_BUNX_CALLS"
if [[ -n "\${MCP_CONFORMANCE_TOKEN:-}" ]]; then exit 29; fi
if [[ "$2" == 'server' ]]; then exit 23; fi
`);

    const result = runWith({
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      MCP_CONFORMANCE_TARGET_URL: 'http://127.0.0.1:8787/mcp',
      MCP_CONFORMANCE_TOKEN: 'runner-lifecycle-probe',
      FAKE_PROXY_STOPPED: stoppedFile,
      FAKE_BUNX_CALLS: callsFile,
    });

    expect(result.status).toBe(23);
    expect(existsSync(stoppedFile)).toBe(true);
    expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual([
      '@modelcontextprotocol/conformance list --requirements 2026-07-28',
      '@modelcontextprotocol/conformance server --url http://127.0.0.1:8788/mcp --requirements 2026-07-28',
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain('runner-lifecycle-probe');
  });
});

function writeExecutable(directory: string, name: string, source: string): void {
  const file = join(directory, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}
