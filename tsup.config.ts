import { defineConfig } from 'tsup';

const externalNative = [
  'electron',
  'better-sqlite3',
  '@anthropic-ai/sdk',
  '@cursor/sdk',
  '@modelcontextprotocol/sdk',
  '@larksuite/cli',
];

export default defineConfig([
  {
    name: 'electron-main',
    entry: {
      'electron/main': 'electron/main.ts',
      'electron/preload': 'electron/preload.ts',
    },
    outDir: 'dist',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: true,
    external: externalNative,
  },
  {
    name: 'cli',
    entry: {
      'cli/index': 'src/cli/index.ts',
      'host/cursor/hook-entry': 'src/host/cursor/hook-entry.ts',
      'mcp/stdio': 'src/mcp/stdio.ts',
    },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    splitting: false,
    external: externalNative,
  },
]);
