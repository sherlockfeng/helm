#!/usr/bin/env node
/**
 * R-17 — CI lint: every e2e directory must have an attack.spec.ts.
 *
 * The reviewer report observed that several e2e directories had a
 * happy.spec.ts but no attack.spec.ts. Without an attack file the
 * test suite covers only the golden path and silently lets regressions
 * land. This lint walks `tests/e2e/<dir>/` and fails when:
 *
 *   - the directory has any `*.spec.ts` file (so it's an actual test
 *     suite, not an `_helpers/` support dir), AND
 *   - it has no `attack.spec.ts`.
 *
 * A directory can opt out with a `.attack-exempt` marker file when
 * the surface genuinely has no adversarial axis (rare — almost every
 * surface has *some* attack surface; we want the lint to push the
 * conversation rather than rubber-stamp).
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const E2E_ROOT = new URL('../tests/e2e/', import.meta.url).pathname;

function listSubdirs(root) {
  return readdirSync(root)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .filter((name) => statSync(join(root, name)).isDirectory());
}

function hasSpecFile(dir) {
  return readdirSync(dir).some((f) => f.endsWith('.spec.ts'));
}

function hasAttackSpec(dir) {
  return existsSync(join(dir, 'attack.spec.ts'));
}

function isExempt(dir) {
  return existsSync(join(dir, '.attack-exempt'));
}

const missing = [];
for (const sub of listSubdirs(E2E_ROOT)) {
  const dir = join(E2E_ROOT, sub);
  if (!hasSpecFile(dir)) continue;
  if (isExempt(dir)) continue;
  if (!hasAttackSpec(dir)) missing.push(sub);
}

if (missing.length === 0) {
  console.log(`[check-attack-coverage] all ${listSubdirs(E2E_ROOT).length} e2e dirs have attack.spec.ts (or .attack-exempt).`);
  process.exit(0);
}

console.error(`[check-attack-coverage] ${missing.length} e2e dir(s) missing attack.spec.ts:`);
for (const dir of missing) console.error(`  - tests/e2e/${dir}/attack.spec.ts`);
console.error(
  `\nAdd an attack.spec.ts that exercises the adversarial axis of this surface\n`
  + `(bad input, race, partial failure, attempt to bypass a guard) — or, if the\n`
  + `surface genuinely has no attack surface, drop an empty \`.attack-exempt\`\n`
  + `marker file in the directory with a one-line justification in the commit.\n`,
);
process.exit(1);
