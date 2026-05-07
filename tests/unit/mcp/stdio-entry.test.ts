/**
 * Phase 44 regression guard: verify `src/mcp/run.ts` actually invokes
 * `main()` at module load. Without it, `node dist/mcp/stdio.js` (which
 * is what Cursor / any external MCP client spawns) imports the bundle,
 * `main` becomes a dangling export, and the process exits silently —
 * Cursor's MCP UI shows "server failed to start" with no helpful logs.
 *
 * We do this as a source-text assertion (cheap, no child process) so a
 * future refactor that drops the call gets caught at test time.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const RUN_TS = join(REPO_ROOT, 'src', 'mcp', 'run.ts');

describe('mcp/run.ts entry contract (Phase 44)', () => {
  it('calls main() at module load so `node dist/mcp/stdio.js` actually starts the server', () => {
    const src = readFileSync(RUN_TS, 'utf8');
    // Look for an unconditional top-level invocation. Defensive: also
    // match `main();` directly + `main().then(...)` etc.
    const hasInvocation = /(?:^|\n)(?:void\s+)?main\s*\(\)/m.test(src);
    expect(hasInvocation, 'src/mcp/run.ts must invoke main() at module load').toBe(true);
  });

  it('the invocation handles errors so a fatal init surfaces to stderr (not silent exit 0)', () => {
    const src = readFileSync(RUN_TS, 'utf8');
    // Either main().catch(...) or try/catch wrapping a call.
    const handlesError = /main\s*\(\)\s*\.catch\b/.test(src)
      || /try\s*\{[^}]*main\s*\(\)/m.test(src);
    expect(handlesError, 'main() must have a .catch handler that writes to stderr + exits non-zero').toBe(true);
  });
});
