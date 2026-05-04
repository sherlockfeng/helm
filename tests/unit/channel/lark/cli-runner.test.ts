/**
 * cli-runner — focused on resolveLarkCliCommand + run() short-lived behavior.
 *
 * The long-lived `spawn()` path is exercised end-to-end by the listener tests
 * with a fake-runner double; trying to test it here against a real lark-cli
 * binary would be flaky in CI.
 *
 * For run(), we shell out to /bin/sh -c so we can verify stdout / stderr /
 * exit-code wiring without needing lark-cli installed.
 */

import { describe, expect, it } from 'vitest';
import {
  createLarkCliRunner,
  resolveLarkCliCommand,
} from '../../../../src/channel/lark/cli-runner.js';

describe('resolveLarkCliCommand', () => {
  it('explicit options.command wins', () => {
    expect(resolveLarkCliCommand({ command: '/usr/local/bin/lark-cli' }))
      .toBe('/usr/local/bin/lark-cli');
  });

  it('LARK_CLI_COMMAND env var takes precedence over the bundled fallback', () => {
    expect(resolveLarkCliCommand({ env: { LARK_CLI_COMMAND: '/opt/lark-cli' } }))
      .toBe('/opt/lark-cli');
  });

  it('whitespace-only env var is ignored, falls back to bundled command', () => {
    const cmd = resolveLarkCliCommand({ env: { LARK_CLI_COMMAND: '   ' } });
    expect(cmd).toMatch(/lark-cli/);
  });
});

describe('cli-runner.run() — short-lived process behavior (sh shim)', () => {
  it('captures stdout / stderr / exitCode', async () => {
    const runner = createLarkCliRunner({ command: '/bin/sh' });
    const result = await runner.run(['-c', 'echo hello; echo oops 1>&2; exit 3']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr.trim()).toBe('oops');
    expect(result.exitCode).toBe(3);
  });

  it('attack: spawn ENOENT surfaces as a rejected promise', async () => {
    const runner = createLarkCliRunner({ command: '/no/such/binary' });
    await expect(runner.run([])).rejects.toThrow();
  });

  it('attack: timeout kills the process and rejects', async () => {
    const runner = createLarkCliRunner({ command: '/bin/sh' });
    await expect(
      runner.run(['-c', 'sleep 5'], { timeoutMs: 50 }),
    ).rejects.toThrow(/timeout/);
  });
});

describe('cli-runner.spawn() — line splitting', () => {
  it('emits each newline-terminated line and handles split chunks', async () => {
    const runner = createLarkCliRunner({ command: '/bin/sh' });
    // Print three lines deterministically. With small writes, splitter must
    // accumulate even when chunks straddle boundaries.
    const handle = runner.spawn(['-c', 'printf "alpha\\nbeta\\ngamma\\n"']);
    const lines: string[] = [];
    handle.onStdoutLine((l) => lines.push(l));
    await handle.exited;
    expect(lines).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('kill() terminates the subprocess', async () => {
    const runner = createLarkCliRunner({ command: '/bin/sh' });
    const handle = runner.spawn(['-c', 'sleep 5']);
    handle.kill('SIGTERM');
    const result = await handle.exited;
    // Either signal-terminated or non-zero exit code; both acceptable.
    expect(result.signal === 'SIGTERM' || (result.exitCode !== 0 && result.exitCode !== null)).toBe(true);
  });
});
