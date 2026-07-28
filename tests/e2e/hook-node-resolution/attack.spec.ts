/**
 * E2e — attack variants for hook-command node resolution.
 *
 * The reported failure is the first spec here: a config whose interpreter is
 * `/opt/homebrew/Cellar/node/26.0.0/bin/node`, a node that has since been
 * deleted. Everything else probes the ways that fix could still leave a user
 * broken: a hostile spawn environment, a HELM_HOME with spaces in it, a
 * poisoned resolution cache, a machine with no node at all, and a bridge
 * that isn't listening.
 *
 * Non-negotiable across all of them: the hook must never break the host. Exit
 * 0, a parseable JSON response on stdout, nothing on stderr that would spam
 * the user's session every turn.
 */

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import {
  installClaudeCodeHooks,
  repairClaudeCodeHookCommands,
} from '../../../src/host/claude-code/installer.js';
import { getHostSession } from '../../../src/storage/repos/host-sessions.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const HOOK_BIN = join(REPO_ROOT, 'bin', 'helm-hook-claude.mjs');
const COMPILED_ENTRY = join(REPO_ROOT, 'out', 'host', 'claude-code', 'hook-entry.js');
const DEAD_NODE = '/opt/homebrew/Cellar/node/26.0.0/bin/node';

let harness: E2eHarness;
let tmpDir: string;
let settingsPath: string;
let helmHome: string;

beforeAll(() => {
  execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsup'), [], {
    cwd: REPO_ROOT, stdio: 'ignore', timeout: 120_000,
  });
  expect(existsSync(COMPILED_ENTRY)).toBe(true);
});

beforeEach(async () => {
  harness = await bootE2e();
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-hookcmd-atk-'));
  settingsPath = join(tmpDir, 'settings.json');
  helmHome = join(tmpDir, '.helm');
});

afterEach(async () => {
  await harness.shutdown();
  rmSync(tmpDir, { recursive: true, force: true });
});

function installedCommand(event: string): string {
  const cfg = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return cfg.hooks[event]!.flatMap((g) => g.hooks)
    .find((h) => h.command.includes('helm-hook'))!.command;
}

interface HookRun { stdout: string; stderr: string; status: number }

/**
 * Async on purpose: the bridge lives in this process, so a synchronous spawn
 * would block the event loop and every hook would "fail" by timing out.
 */
function runRaw(command: string, input: string, env: NodeJS.ProcessEnv): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env: env as Record<string, string> });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => resolve({ stdout, stderr, status: code ?? -1 }));
    child.stdin.end(input);
  });
}

function runCommand(command: string, payload: object, env: NodeJS.ProcessEnv): Promise<HookRun> {
  return runRaw(command, JSON.stringify(payload), env);
}

/** GUI launch: no PATH in the spawn env. The harder of the two cases. */
function guiEnv(overrides: NodeJS.ProcessEnv = {}, home = helmHome): NodeJS.ProcessEnv {
  return {
    HOME: process.env['HOME']!,
    HELM_HOME: home,
    HELM_BRIDGE_SOCKET: harness.socketPath,
    ...overrides,
  };
}

function promptPayload(sessionId: string, prompt: string): object {
  return { session_id: sessionId, cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt };
}

/** settings.json exactly as an older helm build left it. */
function seedLegacyInstall(nodePath = DEAD_NODE): void {
  writeFileSync(settingsPath, `${JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{
        type: 'command',
        command: `'${nodePath}' '${HOOK_BIN}' --event 'UserPromptSubmit'`,
        timeout: 60,
      }] }],
    },
  }, null, 2)}\n`);
}

describe('hook-node-resolution attack', () => {
  it('the reported bug: a config pointing at a deleted node captures nothing, and is repaired into one that does', async () => {
    seedLegacyInstall();
    expect(existsSync(DEAD_NODE)).toBe(false); // the premise

    // Before: the host spawns it, /bin/sh reports a missing interpreter every
    // single turn, and helm never sees the prompt.
    const broken = await runCommand(
      installedCommand('UserPromptSubmit'),
      promptPayload('sess_dead', 'this one is lost'),
      guiEnv(),
    );
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain('No such file or directory');
    expect(getHostSession(harness.db, 'sess_dead')).toBeUndefined();

    // After the repair (what helm now does on boot): same config file, live hook.
    expect(repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN, helmHome).repaired)
      .toBe(true);

    const fixed = await runCommand(
      installedCommand('UserPromptSubmit'),
      promptPayload('sess_repaired', 'this one lands'),
      guiEnv(),
    );
    expect(fixed.status).toBe(0);
    expect(fixed.stderr).toBe('');
    expect(getHostSession(harness.db, 'sess_repaired')?.firstPrompt).toBe('this one lands');
  });

  it('a repaired config survives the next installer run (the hand-fix used to get clobbered)', async () => {
    seedLegacyInstall();
    repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN, helmHome);
    const repaired = readFileSync(settingsPath, 'utf8');

    // App restarts → installer runs again → must not reintroduce a node path.
    installClaudeCodeHooks({ hooksPath: settingsPath, events: ['UserPromptSubmit'] }, HOOK_BIN, helmHome);
    expect(readFileSync(settingsPath, 'utf8')).toBe(repaired);
    expect(installedCommand('UserPromptSubmit')).not.toContain('/bin/node');

    const r = await runCommand(
      installedCommand('UserPromptSubmit'),
      promptPayload('sess_after_reinstall', 'still working'),
      guiEnv(),
    );
    expect(r.status).toBe(0);
    expect(getHostSession(harness.db, 'sess_after_reinstall')?.firstPrompt).toBe('still working');
  });

  it('poisoned resolution cache (its node was deleted) self-heals mid-flight', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);
    mkdirSync(join(helmHome, 'cache'), { recursive: true });
    writeFileSync(join(helmHome, 'cache', 'hook-node-path'), `${DEAD_NODE}\n`, 'utf8');

    const r = await runCommand(
      installedCommand('UserPromptSubmit'),
      promptPayload('sess_poison', 'cache was stale'),
      guiEnv(),
    );

    expect(r.status).toBe(0);
    expect(getHostSession(harness.db, 'sess_poison')?.firstPrompt).toBe('cache was stale');
    expect(readFileSync(join(helmHome, 'cache', 'hook-node-path'), 'utf8')).not.toContain(DEAD_NODE);
  });

  it('HELM_HOME with spaces and a quote in the path still produces a runnable command', async () => {
    const weirdHome = join(tmpDir, "a dir with spaces and ' quote", '.helm');
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, weirdHome);

    const r = await runCommand(
      installedCommand('UserPromptSubmit'),
      promptPayload('sess_spaces', 'quoting holds'),
      guiEnv({}, weirdHome),
    );
    expect(r.status).toBe(0);
    expect(getHostSession(harness.db, 'sess_spaces')?.firstPrompt).toBe('quoting holds');
  });

  it('no node reachable at all: host gets a clean empty response, never a crash', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);
    // A HOME with nothing in it, a PATH that resolves nothing, no login shell.
    const barrenHome = join(tmpDir, 'barren');
    mkdirSync(barrenHome, { recursive: true });

    const r = await runCommand(installedCommand('UserPromptSubmit'), promptPayload('sess_nonode', 'lost'), {
      HOME: barrenHome,
      NVM_DIR: join(barrenHome, '.nvm'),
      PATH: join(barrenHome, 'nothing'),
      SHELL: '/nonexistent/sh',
      HELM_HOME: helmHome,
      HELM_BRIDGE_SOCKET: harness.socketPath,
    });

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    // Degraded, and it says so somewhere the user can find — but on disk,
    // not on the host's stdout.
    expect(readFileSync(join(helmHome, 'logs', 'hook-launcher.log'), 'utf8'))
      .toContain('no usable node found');
    expect(getHostSession(harness.db, 'sess_nonode')).toBeUndefined();
  });

  it('bridge socket missing (helm not running): hook still exits clean', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);

    const r = await runCommand(
      installedCommand('UserPromptSubmit'),
      promptPayload('sess_nobridge', 'helm is down'),
      guiEnv({ HELM_BRIDGE_SOCKET: join(tmpDir, 'not-a-socket.sock') }),
    );

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });

  it('read-only HELM_HOME (no launcher can be written): install still yields a working command', async () => {
    const readonlyRoot = join(tmpDir, 'ro');
    mkdirSync(readonlyRoot, { recursive: true });
    chmodSync(readonlyRoot, 0o500);
    try {
      installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, join(readonlyRoot, '.helm'));
      // Falls back to PATH-based resolution, so this one needs a PATH.
      const r = await runCommand(installedCommand('UserPromptSubmit'), promptPayload('sess_ro', 'fallback works'), {
        HOME: process.env['HOME']!,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HELM_BRIDGE_SOCKET: harness.socketPath,
      });
      expect(r.status).toBe(0);
      expect(getHostSession(harness.db, 'sess_ro')?.firstPrompt).toBe('fallback works');
    } finally {
      chmodSync(readonlyRoot, 0o700);
    }
  });

  it('a truncated/garbage payload on stdin does not take the hook down', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);
    const r = await runRaw(
      installedCommand('UserPromptSubmit'),
      '{"session_id": "sess_trunc", "prompt": "unterminated',
      guiEnv(),
    );

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });
});
