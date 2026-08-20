import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const appRoot = resolve(import.meta.dirname, 'apps/transit-board');

function trimGeneratedWhitespace(): Plugin {
  return {
    name: 'metro-mcp:trim-generated-whitespace',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const artifact = bundle['transit-board.html'];

      if (artifact?.type === 'asset' && typeof artifact.source === 'string') {
        artifact.source = artifact.source.replace(/\n[\t ]+\n/g, '\n\n');
      }
    },
  };
}

export default defineConfig({
  root: appRoot,
  publicDir: false,
  plugins: [viteSingleFile(), trimGeneratedWhitespace()],
  build: {
    modulePreload: false,
    outDir: resolve(import.meta.dirname, 'public/apps'),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(appRoot, 'transit-board.html'),
    },
  },
});
