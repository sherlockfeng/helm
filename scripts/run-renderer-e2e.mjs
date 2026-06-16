#!/usr/bin/env node
/**
 * Runs the renderer e2e specs against a real Electron app.
 *
 * better-sqlite3 is a native module: the unit/e2e suites + a dev checkout
 * need it built for Node's ABI, but the renderer specs launch real Electron,
 * which needs Electron's ABI. This wrapper swaps ABIs around the run.
 *
 * Why a script instead of the old one-liner
 *   `electron-rebuild && vitest ...; pnpm rebuild better-sqlite3`:
 *
 * 1. EXIT CODE: the trailing `; pnpm rebuild` made the script's exit code
 *    that of `pnpm rebuild`, not vitest — so renderer-spec failures were
 *    SWALLOWED and the CI job went green regardless. The gate was toothless.
 *    Here we capture vitest's status and exit with it (after restoring ABI).
 *
 * 2. DETERMINISTIC REBUILD: @electron/rebuild intermittently left the module
 *    at Node's ABI (NODE_MODULE_VERSION 115) instead of Electron's (130) —
 *    a stale-build/cache flake — so the app crashed on launch with
 *    "compiled against NODE_MODULE_VERSION 115 ... requires 130" and every
 *    spec timed out waiting for the window. We delete the existing build,
 *    pass Electron's version explicitly, and force a from-source rebuild so
 *    the target ABI can't drift.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;

function run(cmd) {
  console.log(`\n[renderer-e2e] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

console.log(`[renderer-e2e] target Electron ${electronVersion}`);

// 1. Clean any prior build so @electron/rebuild can't reuse a Node-ABI
//    binary, then force a from-source rebuild against Electron's headers.
try {
  execSync(
    'rm -rf node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build '
    + 'node_modules/better-sqlite3/build',
    { stdio: 'inherit' },
  );
} catch {/* nothing to clean */}
run(`./node_modules/.bin/electron-rebuild -f -o better-sqlite3 -v ${electronVersion}`);

// 2. Run the specs, capturing pass/fail without letting the ABI-restore
//    step below mask it.
let testsFailed = false;
try {
  run('./node_modules/.bin/vitest run --config tests/e2e/renderer/vitest.config.ts');
} catch {
  testsFailed = true;
}

// 3. ALWAYS restore Node's ABI so the unit/e2e suites + a dev checkout stay
//    runnable, even when the specs failed.
try {
  run('pnpm rebuild better-sqlite3');
} catch (err) {
  console.error('[renderer-e2e] WARNING: failed to restore Node ABI for better-sqlite3:', err?.message);
}

process.exit(testsFailed ? 1 : 0);
