import { defineConfig } from 'tsup';

const externalNative = [
  'electron',
  'better-sqlite3',
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
    // Output to `out/` (not `dist/`) because electron-builder
    // hardcodes `!dist{,/**/*}` in its default file-pattern
    // exclusions — there's no clean way to re-include from there.
    // Renaming the source output sidesteps the conflict entirely.
    outDir: 'out',
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
      'mcp/stdio': 'src/mcp/run.ts',
    },
    // Output to `out/` (not `dist/`) because electron-builder
    // hardcodes `!dist{,/**/*}` in its default file-pattern
    // exclusions — there's no clean way to re-include from there.
    // Renaming the source output sidesteps the conflict entirely.
    outDir: 'out',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    splitting: false,
    external: externalNative,
  },
]);
