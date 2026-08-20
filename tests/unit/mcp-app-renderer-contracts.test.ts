import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const projectPath = (path: string) => resolve(process.cwd(), path);

describe('Transit Board renderer build contracts', () => {
  it('type-checks the renderer test and representative fixture in the browser program', () => {
    const listedFiles = execFileSync(
      process.execPath,
      [
        projectPath('node_modules/typescript/bin/tsc'),
        '-p',
        'apps/transit-board/tsconfig.json',
        '--noEmit',
        '--listFilesOnly',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(listedFiles).toContain(projectPath('tests/unit/mcp-app-renderers.test.ts'));
    expect(listedFiles).toContain(projectPath('tests/fixtures/mcp-contracts.ts'));
  });
});
