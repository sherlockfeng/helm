/**
 * Tests for the runCli dispatch — verifies subcommand routing, output, and
 * exit codes without touching the real filesystem.
 *
 * The `install-hooks` / `uninstall-hooks` CLI surfaces are intentionally NOT
 * unit-tested here: they call `installCursorHooks()` with the default path
 * `~/.cursor/hooks.json`, which would mutate the developer's real Cursor
 * config. The underlying installer module has 15 dedicated tests
 * (installer.test.ts) that exercise every branch with tmp paths. The CLI
 * wrapper is just commander glue — covered by typecheck + manual smoke.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { runCli } from '../../../src/cli/index.js';

let outLines: string[];
let errLines: string[];
let exitCodes: number[];

function harness(argv: string[]) {
  return {
    argv: ['node', 'helm', ...argv],
    out: (line: string) => outLines.push(line),
    err: (line: string) => errLines.push(line),
    exit: (code: number) => exitCodes.push(code),
  };
}

beforeEach(() => {
  outLines = [];
  errLines = [];
  exitCodes = [];
});

describe('runCli — dispatch', () => {
  it('--help exits cleanly without throwing', async () => {
    await runCli(harness(['--help']));
    expect(exitCodes.length).toBeGreaterThanOrEqual(1);
  });

  it('unknown subcommand exits non-zero', async () => {
    await runCli(harness(['totallyUnknown']));
    expect(exitCodes[0] ?? 0).not.toBe(0);
  });
});

describe('runCli — doctor', () => {
  it('emits human-readable text by default', async () => {
    await runCli(harness(['doctor']));
    const text = outLines.join('\n');
    expect(text).toContain('Helm Doctor');
    // Status icons proves the formatter ran, regardless of which checks pass.
    expect(text).toMatch(/[✓⚠✗·]/);
  });

  it('--json emits valid JSON with checks[]', async () => {
    await runCli(harness(['doctor', '--json']));
    expect(outLines).toHaveLength(1);
    const parsed = JSON.parse(outLines[0]!);
    expect(parsed).toMatchObject({ node: expect.any(Object), checks: expect.any(Array) });
    expect(typeof parsed.healthy).toBe('boolean');
  });

  it('exits 0 when healthy, non-zero when not', async () => {
    await runCli(harness(['doctor', '--json']));
    expect(exitCodes).toHaveLength(1);
    const parsed = JSON.parse(outLines[0]!);
    expect(exitCodes[0]).toBe(parsed.healthy ? 0 : 1);
  });
});
