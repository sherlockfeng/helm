/**
 * Unit tests for the hook launcher — the sh shim the host configs point at
 * instead of an absolute node path.
 *
 * These do NOT stop at "the file was generated": every resolution test
 * actually runs the generated script under /bin/sh with a synthetic
 * environment, because the whole bug class being fixed here (a baked-in
 * `/opt/homebrew/Cellar/node/26.0.0/bin/node` that no longer exists) only
 * shows up at run time, in an environment nobody tested.
 *
 * Environments exercised:
 *   - terminal launch: node on PATH
 *   - GUI launch: NO PATH at all, node only findable on disk (nvm layout)
 *   - poisoned cache: last known-good node has been deleted
 *   - hostile: no node anywhere → must not break the host
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_LAUNCHER_NAME,
  ensureHookLauncher,
  hookInterpreterPrefix,
  hookLauncherPath,
  renderHookLauncher,
  shellQuote,
} from '../../../src/host/hook-launcher.js';

let tmpDir: string;
let helmHome: string;
let launcher: string;

/** A stand-in for the hook entry: prints which node ran it, plus its argv. */
const PROBE_JS = 'console.log(JSON.stringify({node: process.execPath, argv: process.argv.slice(1)}));\n';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-launcher-'));
  helmHome = join(tmpDir, '.helm');
  launcher = ensureHookLauncher(helmHome);
  writeFileSync(join(tmpDir, 'probe.mjs'), PROBE_JS, 'utf8');
});

afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

/**
 * A fake node: reports `--version` as the requested version and otherwise
 * runs the real node so the hook entry still works. Lets us build version
 * layouts (v16 vs v22) without installing anything.
 */
function fakeNode(path_: string, version: string): void {
  mkdirSync(join(path_, '..'), { recursive: true });
  writeFileSync(path_, [
    '#!/bin/sh',
    `if [ "\${1:-}" = "--version" ]; then echo "${version}"; exit 0; fi`,
    `exec ${process.execPath} "$@"`,
    '',
  ].join('\n'), 'utf8');
  chmodSync(path_, 0o755);
}

interface RunResult { stdout: string; status: number }

function runLauncher(env: NodeJS.ProcessEnv, args: string[] = []): RunResult {
  try {
    const stdout = execFileSync('/bin/sh', [launcher, join(tmpDir, 'probe.mjs'), ...args], {
      env: env as Record<string, string>,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

/** GUI launch: no PATH, no SHELL — the environment Claude Code hands a hook
 *  when it was itself started from the Dock. */
function guiEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: tmpDir, HELM_HOME: helmHome, NVM_DIR: join(tmpDir, '.nvm'), ...overrides };
}

describe('hook launcher generation', () => {
  it('writes an executable script at $HELM_HOME/bin/helm-hook-node', () => {
    expect(launcher).toBe(hookLauncherPath(helmHome));
    expect(launcher.endsWith(`/bin/${HOOK_LAUNCHER_NAME}`)).toBe(true);
    // 0o111 — executable by someone; hosts spawn it directly.
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it('name carries the helm-hook marker so installers still recognise the command', () => {
    // The installers strip/detect their own entries by substring; if the
    // launcher name ever loses the marker, uninstall silently stops working.
    expect(HOOK_LAUNCHER_NAME).toContain('helm-hook');
  });

  it('is valid POSIX sh (sh -n) and contains no bashisms we rely on', () => {
    expect(() => execFileSync('/bin/sh', ['-n', launcher], { encoding: 'utf8' })).not.toThrow();
    const body = readFileSync(launcher, 'utf8');
    expect(body).not.toMatch(/^\s*local\s/m);
    expect(body).not.toMatch(/\[\[/);
  });

  it('never bakes in the running process node path (that is the bug being fixed)', () => {
    expect(readFileSync(launcher, 'utf8')).not.toContain(process.execPath);
  });

  it('rewrites a stale launcher body in place, keeping the same path', () => {
    writeFileSync(launcher, '#!/bin/sh\nexit 7\n', 'utf8');
    const again = ensureHookLauncher(helmHome);
    expect(again).toBe(launcher);
    expect(readFileSync(launcher, 'utf8')).toBe(renderHookLauncher());
  });

  it('restores the executable bit if something stripped it', () => {
    chmodSync(launcher, 0o644);
    ensureHookLauncher(helmHome);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it('hookInterpreterPrefix returns the shell-quoted launcher path', () => {
    expect(hookInterpreterPrefix(helmHome)).toBe(shellQuote(launcher));
  });

  it('hookInterpreterPrefix falls back to env-based node when the launcher cannot be written', () => {
    // Read-only parent dir: an install must still produce a runnable command
    // rather than throwing and leaving the host unhooked.
    const locked = join(tmpDir, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    try {
      expect(hookInterpreterPrefix(join(locked, 'helm'))).toBe('/usr/bin/env node');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('hook launcher node resolution', () => {
  it('terminal launch: uses node from PATH', () => {
    const r = runLauncher(guiEnv({ PATH: join(process.execPath, '..') }), ['--event', 'Stop']);
    const out = JSON.parse(r.stdout) as { node: string; argv: string[] };
    expect(out.node).toBe(process.execPath);
    expect(out.argv).toEqual([join(tmpDir, 'probe.mjs'), '--event', 'Stop']);
  });

  it('GUI launch: resolves node from disk with NO PATH in the environment', () => {
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');
    mkdirSync(join(tmpDir, '.nvm', 'alias'), { recursive: true });
    writeFileSync(join(tmpDir, '.nvm', 'alias', 'default'), '22.18\n', 'utf8');

    const r = runLauncher(guiEnv(), ['--event', 'UserPromptSubmit']);
    const out = JSON.parse(r.stdout) as { node: string };
    expect(out.node).toBe(process.execPath); // fake node execs the real one
    // …and it got there through the nvm layout, not through PATH.
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8').trim())
      .toBe(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'));
  });

  it('nvm alias/default may be a partial version (22.18 → v22.18.0)', () => {
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v20.18.1', 'bin', 'node'), 'v20.18.1');
    mkdirSync(join(tmpDir, '.nvm', 'alias'), { recursive: true });
    writeFileSync(join(tmpDir, '.nvm', 'alias', 'default'), '22.18\n', 'utf8');

    runLauncher(guiEnv(), ['--event', 'Stop']);
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8'))
      .toContain('v22.18.0');
  });

  it('prefers a modern node over an ancient one lying around on disk', () => {
    // Regression: a plain glob picks v16 before v22 (lexicographic), and the
    // hook entry needs >= 20.12 per package.json engines.
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v16.20.2', 'bin', 'node'), 'v16.20.2');
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');

    runLauncher(guiEnv(), ['--event', 'Stop']);
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8'))
      .toContain('v22.18.0');
  });

  it('falls back to an old node only when nothing modern exists', () => {
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v16.20.2', 'bin', 'node'), 'v16.20.2');
    const r = runLauncher(guiEnv(), ['--event', 'Stop']);
    expect(r.status).toBe(0);
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8'))
      .toContain('v16.20.2');
  });

  it('HELM_HOOK_NODE overrides everything', () => {
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');
    const override = join(tmpDir, 'custom', 'node');
    fakeNode(override, 'v24.0.0');

    runLauncher(guiEnv({ HELM_HOOK_NODE: override }), ['--event', 'Stop']);
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8').trim()).toBe(override);
  });
});

describe('hook launcher — attack cases', () => {
  it('poisoned cache (the node it names was deleted) re-resolves and rewrites the cache', () => {
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');
    mkdirSync(join(helmHome, 'cache'), { recursive: true });
    writeFileSync(join(helmHome, 'cache', 'hook-node-path'),
      '/opt/homebrew/Cellar/node/26.0.0/bin/node\n', 'utf8');

    const r = runLauncher(guiEnv(), ['--event', 'Stop']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ node: process.execPath });
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8'))
      .toContain('v22.18.0');
  });

  it('a candidate that exists but does not run (dangling shim) is skipped', () => {
    // asdf-style shim that errors out; -x would accept it, --version won't.
    const shim = join(tmpDir, '.asdf', 'shims', 'node');
    mkdirSync(join(tmpDir, '.asdf', 'shims'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\necho "No version set" >&2\nexit 126\n', 'utf8');
    chmodSync(shim, 0o755);
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');

    const r = runLauncher(guiEnv(), ['--event', 'Stop']);
    expect(r.status).toBe(0);
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8')).toContain('v22.18.0');
  });

  it('no node anywhere: exits 0 with the host\'s neutral response, never a crash', () => {
    const env = guiEnv({ PATH: join(tmpDir, 'nothing-here'), SHELL: '/nonexistent/sh' });

    const stop = runLauncher(env, ['--event', 'Stop']);
    expect(stop.status).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({});

    const submit = runLauncher(env, ['--event', 'beforeSubmitPrompt']);
    expect(JSON.parse(submit.stdout)).toEqual({ continue: true });

    // Cursor's intercept events must degrade to "ask", not to silent allow.
    const approval = runLauncher(env, ['--event', 'preToolUse']);
    expect((JSON.parse(approval.stdout) as { permission: string }).permission).toBe('ask');
  });

  it('no node anywhere: diagnostics go to the log file, never to stdout', () => {
    const r = runLauncher(guiEnv({ PATH: join(tmpDir, 'nope'), SHELL: '/nonexistent/sh' }), ['--event', 'Stop']);
    // stdout must stay parseable as the hook response — a stray log line here
    // is what breaks the host.
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(readFileSync(join(helmHome, 'logs', 'hook-launcher.log'), 'utf8'))
      .toContain('no usable node found');
  });

  it('survives a completely empty environment (no PATH: mkdir/date/sort unavailable)', () => {
    // env -i style. Everything the script needs beyond builtins must come
    // from the PATH floor it sets itself.
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');
    const r = runLauncher({ HOME: tmpDir, HELM_HOME: helmHome, NVM_DIR: join(tmpDir, '.nvm') }, ['--event', 'Stop']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ node: process.execPath });
  });

  it('an unwritable HELM_HOME (no cache, no log) still runs the hook', () => {
    fakeNode(join(tmpDir, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'node'), 'v22.18.0');
    const readonlyHome = join(tmpDir, 'ro');
    mkdirSync(readonlyHome, { recursive: true });
    chmodSync(readonlyHome, 0o500);
    try {
      const r = runLauncher(guiEnv({ HELM_HOME: join(readonlyHome, 'helm') }), ['--event', 'Stop']);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ node: process.execPath });
    } finally {
      chmodSync(readonlyHome, 0o700);
    }
  });

  it('passes hook arguments through verbatim, including spaces and quotes', () => {
    const weird = "it's a --weird one";
    const r = runLauncher(guiEnv({ PATH: join(process.execPath, '..') }), ['--event', weird]);
    expect((JSON.parse(r.stdout) as { argv: string[] }).argv).toEqual([
      join(tmpDir, 'probe.mjs'), '--event', weird,
    ]);
  });
});
