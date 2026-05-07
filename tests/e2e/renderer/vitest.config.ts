import { defineConfig } from 'vitest/config';

/**
 * Renderer e2e — Playwright drives the actual `dist/electron/main.cjs`,
 * which means `better-sqlite3` has to be compiled for Electron's
 * NODE_MODULE_VERSION (130 today), not Node's (127).
 *
 * Run via `pnpm test:e2e:renderer` which does `electron-rebuild` before
 * vitest. The wrapper also rebuilds back to Node afterwards so the
 * non-renderer e2e + unit suites stay green on the same checkout.
 *
 * Renderer specs are slow (booting a real Electron window per test) so the
 * timeout is bumped beyond the rest of the e2e suite.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/renderer/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'web', 'tests/unit'],
    environment: 'node',
    // Cold-start an Electron + helm orchestrator + window-paint can push 30s
    // on a busy machine; give beforeEach plenty of room so flakes don't
    // mask real regressions.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
