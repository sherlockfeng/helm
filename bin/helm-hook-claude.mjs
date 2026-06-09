#!/usr/bin/env node
/**
 * Helm Claude Code hook subprocess entry. Spawned by Claude Code for each
 * UserPromptSubmit / Stop event after installClaudeCodeHooks() has wired
 * this binary into ~/.claude/settings.json.
 *
 *   stdin (Claude Code hook payload JSON)
 *     → bridge UDS request(s)  (observation only — never blocks claude)
 *     → stdout (empty allow response)
 *
 * Logic lives in src/host/claude-code/hook-entry.ts. If the compiled
 * module is missing (running from source without `pnpm build`) we fall
 * back to printing an empty allow response so claude's session is
 * never broken by a missing build artifact.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const outEntry = join(__dirname, '..', 'out', 'host', 'claude-code', 'hook-entry.js');

function fallback() {
  process.stdout.write('{}\n');
}

if (existsSync(outEntry)) {
  const mod = await import(outEntry);
  if (typeof mod.runHook === 'function') {
    await mod.runHook();
  } else {
    fallback();
  }
} else {
  fallback();
}
