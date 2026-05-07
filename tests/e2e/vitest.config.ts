import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    exclude: [
      'node_modules', 'dist', 'web', 'tests/unit',
      // Phase 52: renderer suite runs under a different vitest config
      // (`tests/e2e/renderer/vitest.config.ts`) because it needs Electron-
      // built `better-sqlite3` ABI, while the rest of the e2e suite needs
      // the Node-built one. They can't share a single rebuild step.
      'tests/e2e/renderer/**',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * E2e specs run in their own worker — booting a HelmApp opens a UDS
     * socket + HTTP server per spec; running them concurrent risks file/port
     * contention. The unit suite stays parallel.
     */
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
