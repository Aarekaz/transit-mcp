import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const projectPath = (path: string) => new URL(path, root).pathname;
const readProjectFile = (path: string) => readFileSync(projectPath(path), 'utf8');
const packageJson = JSON.parse(readProjectFile('package.json')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('MCP Apps build pipeline', () => {
  it('pins the Apps build toolchain and composes its commands deterministically', () => {
    expect(packageJson.devDependencies).toMatchObject({
      '@modelcontextprotocol/ext-apps': '1.7.5',
      vite: '8.2.1',
      'vite-plugin-singlefile': '2.3.3',
      'happy-dom': '20.11.6',
    });
    expect(packageJson.scripts).toMatchObject({
      'build:apps': 'vite build --config vite.apps.config.ts',
      build: 'bun run build:apps && bun run type-check',
      dev: 'bun run build:apps && wrangler dev',
      deploy: 'bun run build:apps && wrangler deploy',
      'type-check': 'tsc -p tsconfig.json --noEmit && tsc -p tests/tsconfig.json --noEmit && tsc -p apps/transit-board/tsconfig.json --noEmit && tsc -p tests/apps/tsconfig.json --noEmit',
      test: 'bun run build:apps && bun run test:unit && bun run test:workers',
    });
    expect(existsSync(projectPath('package-lock.json'))).toBe(false);
  });

  it('defines a self-contained browser program and generated Transit Board artifact', () => {
    expect(existsSync(projectPath('vite.apps.config.ts'))).toBe(true);
    expect(existsSync(projectPath('apps/transit-board/transit-board.html'))).toBe(true);
    expect(existsSync(projectPath('apps/transit-board/src/app.ts'))).toBe(true);
    expect(existsSync(projectPath('apps/transit-board/src/styles.css'))).toBe(true);
    expect(existsSync(projectPath('apps/transit-board/tsconfig.json'))).toBe(true);

    const artifact = readProjectFile('public/apps/transit-board.html');
    expect(artifact).toMatch(/^<!doctype html>/i);
    expect(artifact).toContain('<style');
    expect(artifact).toContain('<script');
    expect(artifact).not.toMatch(/<(?:script|link)[^>]+https?:\/\//i);
    expect(artifact).not.toMatch(/\bfetch\s*\(/);
    expect(artifact).not.toMatch(/\n[\t ]+\n/);
  });

  it('builds before rejecting stale generated artifacts and preserving release gates', () => {
    const workflow = readProjectFile('.github/workflows/type-check.yml');
    const buildIndex = workflow.indexOf('bun run build:apps');
    const artifactCheckIndex = workflow.indexOf(
      'git diff --exit-code -- public/apps/transit-board.html',
    );
    const typeCheckIndex = workflow.indexOf('bun run type-check');
    const testIndex = workflow.indexOf('bun run test');
    const dryRunIndex = workflow.indexOf('bunx wrangler deploy --dry-run');

    expect(buildIndex).toBeGreaterThan(-1);
    expect(artifactCheckIndex).toBeGreaterThan(buildIndex);
    expect(typeCheckIndex).toBeGreaterThan(artifactCheckIndex);
    expect(testIndex).toBeGreaterThan(typeCheckIndex);
    expect(dryRunIndex).toBeGreaterThan(testIndex);
  });
});
