import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'web', 'tests/unit'],
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
