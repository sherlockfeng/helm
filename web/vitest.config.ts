import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Web component tests (layer 1) — fast, no Electron.
 *
 * Runs React components in happy-dom with @testing-library so a PR that
 * breaks a page's render, removes a key control, or mis-wires a handler
 * fails CI in seconds — without booting the real app (that's the renderer
 * e2e suite's job, which is slow and not run per-PR).
 *
 * Deliberately NOT folded into the root vitest config: that one is
 * `environment: 'node'` for storage/api/verification suites and explicitly
 * excludes `web/`. Component tests need the DOM env + the React plugin, so
 * they get their own config, run via `pnpm --filter helm-web test`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
