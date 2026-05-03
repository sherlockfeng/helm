#!/usr/bin/env node
/**
 * Helm Cursor hook subprocess entry. Spawned by Cursor for each hook event.
 *
 *   stdin (Cursor hook payload JSON)
 *     → bridge UDS request
 *     → stdout (Cursor hook response JSON)
 *
 * Logic lives in src/host/cursor/hook-entry.ts; this file just resolves the
 * compiled module and invokes runHook. If the compiled module is missing
 * (running from source without `pnpm build`) we fall back to a conservative
 * "ask" / "continue" response so we never block Cursor.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distEntry = join(__dirname, '..', 'dist', 'host', 'cursor', 'hook-entry.js');

function fallback() {
  // No compiled module available. Cursor still needs a valid response shape.
  const argv = process.argv.slice(2);
  let event = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--event') { event = argv[i + 1] ?? ''; break; }
    if (argv[i].startsWith('--event=')) { event = argv[i].slice('--event='.length); break; }
  }
  const lower = event.toLowerCase();
  if (['beforeshellexecution', 'beforemcpexecution', 'pretooluse'].includes(lower)) {
    process.stdout.write(JSON.stringify({
      permission: 'ask',
      user_message: 'Helm bridge not running. Please review this Cursor action locally.',
      agent_message: 'Helm fell back to Cursor local approval (binary not built).',
    }) + '\n');
  } else if (lower === 'beforesubmitprompt') {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  } else {
    process.stdout.write('{}\n');
  }
}

if (existsSync(distEntry)) {
  const mod = await import(distEntry);
  if (typeof mod.runHook === 'function') {
    await mod.runHook();
  } else {
    fallback();
  }
} else {
  fallback();
}
