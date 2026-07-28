/**
 * E2e — the installed hook command actually runs, under both launch styles.
 *
 * This is the flow the bug broke: helm writes a command into
 * `~/.claude/settings.json`, Claude Code spawns it with `/bin/sh -c` from its
 * own environment, and the hook is supposed to reach helm's bridge. The old
 * installer baked `process.execPath` into that command, so when the node that
 * ran the installer disappeared, every invocation printed
 * `No such file or directory` and helm silently stopped capturing.
 *
 * So these specs do not stop at "settings.json looks right". They take the
 * command string verbatim out of the written config, run it through /bin/sh
 * with a real payload on stdin, and assert helm's observable side effect —
 * the prompt landing in the DB.
 *
 * Two environments, both required by the fix:
 *   - terminal launch: the host inherited the user's PATH
 *   - GUI launch (Dock / Spotlight): NO PATH at all in the spawn env
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { installClaudeCodeHooks } from '../../../src/host/claude-code/installer.js';
import { getHostSession } from '../../../src/storage/repos/host-sessions.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const HOOK_BIN = join(REPO_ROOT, 'bin', 'helm-hook-claude.mjs');
const COMPILED_ENTRY = join(REPO_ROOT, 'out', 'host', 'claude-code', 'hook-entry.js');

let harness: E2eHarness;
let tmpDir: string;
let settingsPath: string;
let helmHome: string;

beforeAll(() => {
  // The hook bin loads out/host/claude-code/hook-entry.js; without it the
  // subprocess would fall back to an empty response and the spec would pass
  // for the wrong reason. Build so we're testing real behaviour.
  execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsup'), [], {
    cwd: REPO_ROOT, stdio: 'ignore', timeout: 120_000,
  });
  expect(existsSync(COMPILED_ENTRY)).toBe(true);
});

beforeEach(async () => {
  harness = await bootE2e();
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-hookcmd-'));
  settingsPath = join(tmpDir, 'settings.json');
  helmHome = join(tmpDir, '.helm');
});

afterEach(async () => {
  await harness.shutdown();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The command string helm wrote into settings.json for `event`. */
function installedCommand(event: string): string {
  const cfg = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return cfg.hooks[event]!.flatMap((g) => g.hooks)
    .find((h) => h.command.includes('helm-hook'))!.command;
}

interface HookRun { stdout: string; stderr: string; status: number }

/**
 * Run a command the way the host does: `/bin/sh -c`, payload on stdin,
 * response on stdout.
 *
 * Async on purpose. The bridge the hook talks to lives in THIS process, so a
 * synchronous spawn would block the event loop and the hook would sit there
 * until its bridge timeout — a fake failure that looks exactly like the real
 * bug.
 */
function runCommand(command: string, input: string, env: NodeJS.ProcessEnv): Promise<HookRun> {
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

function runInstalledCommand(
  event: string,
  payload: object,
  env: NodeJS.ProcessEnv,
): Promise<HookRun> {
  return runCommand(installedCommand(event), JSON.stringify(payload), env);
}

/** Claude Code spawned from a terminal: the user's PATH came along. */
function terminalEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env['HOME']!,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HELM_HOME: helmHome,
    HELM_BRIDGE_SOCKET: harness.socketPath,
  };
}

/** Claude Code launched from the Dock: no user shell PATH in the spawn env. */
function guiEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env['HOME']!,
    HELM_HOME: helmHome,
    HELM_BRIDGE_SOCKET: harness.socketPath,
  };
}

function promptPayload(sessionId: string, prompt: string): object {
  return {
    session_id: sessionId,
    cwd: '/Users/me/projects/foo',
    hook_event_name: 'UserPromptSubmit',
    prompt,
  };
}

describe('hook-node-resolution happy', () => {
  it('terminal launch: the installed command runs and helm captures the prompt', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);

    const r = await runInstalledCommand(
      'UserPromptSubmit',
      promptPayload('sess_terminal', 'fix the login redirect bug'),
      terminalEnv(),
    );

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({});
    // The side effect, not just the absence of an error.
    expect(getHostSession(harness.db, 'sess_terminal')?.firstPrompt)
      .toBe('fix the login redirect bug');
  });

  it('GUI launch (no PATH in the spawn env): still runs, still captures', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);

    const r = await runInstalledCommand(
      'UserPromptSubmit',
      promptPayload('sess_gui', 'ship the release notes'),
      guiEnv(),
    );

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(getHostSession(harness.db, 'sess_gui')?.firstPrompt).toBe('ship the release notes');
  });

  it('re-running the installer leaves a working config working', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);
    const first = readFileSync(settingsPath, 'utf8');

    // Simulates the next app launch running the installer again — the move
    // that used to overwrite the user's hand-fixed `node` back to a dead
    // absolute path.
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);
    expect(readFileSync(settingsPath, 'utf8')).toBe(first);

    const r = await runInstalledCommand(
      'UserPromptSubmit',
      promptPayload('sess_reinstall', 'after reinstall'),
      guiEnv(),
    );
    expect(r.status).toBe(0);
    expect(getHostSession(harness.db, 'sess_reinstall')?.firstPrompt).toBe('after reinstall');
  });

  it('the Stop hook path also runs end-to-end', async () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN, helmHome);
    await runInstalledCommand(
      'UserPromptSubmit',
      promptPayload('sess_stop', 'do the thing'),
      guiEnv(),
    );

    const r = await runInstalledCommand('Stop', {
      session_id: 'sess_stop',
      cwd: '/Users/me/projects/foo',
      hook_event_name: 'Stop',
    }, guiEnv());

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    expect(getHostSession(harness.db, 'sess_stop')).toBeTruthy();
  });
});
