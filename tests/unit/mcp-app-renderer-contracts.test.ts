import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const projectPath = (path: string) => resolve(process.cwd(), path);

describe('Transit Board renderer build contracts', () => {
  it('defines an observable reflow contract that includes a 320px viewport', () => {
    const styles = readFileSync(projectPath('apps/transit-board/src/styles.css'), 'utf8');
    const narrowRule = styles.match(
      /@media \(max-width: 23\.75rem\) \{([\s\S]*?)\n\}\n\n@media \(prefers-reduced-motion/,
    )?.[1];

    expect(narrowRule).toBeDefined();
    expect(narrowRule).toMatch(
      /\.view-header\s*\{\s*grid-template-columns: minmax\(0, 1fr\);\s*\}/,
    );
    expect(narrowRule).toMatch(
      /\.filter-bar\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(narrowRule).toMatch(
      /\.station-select\s*\{\s*grid-template-columns: minmax\(0, 1fr\);\s*\}/,
    );
  });

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
