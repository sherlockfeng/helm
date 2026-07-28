import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_CLAUDE_EVENTS,
  installClaudeCodeHooks,
  isClaudeCodeHooksInstalled,
  repairClaudeCodeHookCommands,
  uninstallClaudeCodeHooks,
} from '../../../../src/host/claude-code/installer.js';
import { hookLauncherPath } from '../../../../src/host/hook-launcher.js';

let tmpDir: string;
let settingsPath: string;
let helmHome: string;
let previousHelmHome: string | undefined;
const HOOK_BIN = '/abs/path/to/helm-hook-claude';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-claude-installer-'));
  settingsPath = join(tmpDir, 'settings.json');
  // Keep the generated launcher inside the tmp dir — an installer test must
  // not write into the developer's real ~/.helm.
  helmHome = join(tmpDir, '.helm');
  previousHelmHome = process.env['HELM_HOME'];
  process.env['HELM_HOME'] = helmHome;
});

afterEach(() => {
  if (previousHelmHome === undefined) delete process.env['HELM_HOME'];
  else process.env['HELM_HOME'] = previousHelmHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The single helm command string wired onto `event`. */
function helmCommand(event = 'UserPromptSubmit'): string {
  const cfg = readSettings();
  const groups = ((cfg['hooks'] as Record<string, unknown>)[event]) as Array<{
    hooks: Array<{ command: string }>;
  }>;
  const inner = groups.flatMap((g) => g.hooks).find((h) => h.command.includes('helm-hook'));
  return inner!.command;
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

describe('installClaudeCodeHooks', () => {
  it('writes a fresh settings.json with UserPromptSubmit + Stop wired', () => {
    const result = installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    expect(result.events).toEqual([...ALL_CLAUDE_EVENTS]);
    const cfg = readSettings();
    const hooks = cfg['hooks'] as Record<string, unknown>;
    expect(Array.isArray(hooks['UserPromptSubmit'])).toBe(true);
    expect(Array.isArray(hooks['Stop'])).toBe(true);
  });

  it('hook command embeds the bin path and event name', () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    const cfg = readSettings();
    const group = ((cfg['hooks'] as Record<string, unknown>)['UserPromptSubmit'] as Array<{
      hooks: Array<{ command: string }>;
    }>)[0];
    const inner = group!.hooks[0]!;
    expect(inner.command).toContain(HOOK_BIN);
    expect(inner.command).toContain('UserPromptSubmit');
  });

  it('preserves user-added settings keys (theme etc.)', () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', other: { a: 1 } }, null, 2));
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    const cfg = readSettings();
    expect(cfg['theme']).toBe('dark');
    expect((cfg['other'] as Record<string, unknown>)['a']).toBe(1);
    expect((cfg['hooks'] as Record<string, unknown>)['UserPromptSubmit']).toBeDefined();
  });

  it('preserves non-helm hook entries on the same event (idempotent re-install)', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/usr/local/bin/some-other-tool' }] },
        ],
      },
    }, null, 2));
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN); // second run

    const cfg = readSettings();
    const groups = (cfg['hooks'] as Record<string, unknown>)['UserPromptSubmit'] as Array<{
      hooks: Array<{ command: string }>;
    }>;
    // Other tool's group survives untouched.
    const otherGroup = groups.find((g) => g.hooks.some((h) => h.command.includes('some-other-tool')));
    expect(otherGroup).toBeDefined();
    // Exactly one helm group, not two.
    const helmGroups = groups.filter((g) => g.hooks.some((h) => h.command.includes(HOOK_BIN)));
    expect(helmGroups).toHaveLength(1);
  });

  it('uninstall removes only helm entries; other tools survive', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/usr/local/bin/other' }] },
        ],
      },
    }, null, 2));
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    uninstallClaudeCodeHooks({ hooksPath: settingsPath });

    const cfg = readSettings();
    const groups = (cfg['hooks'] as Record<string, unknown>)['UserPromptSubmit'] as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hooks[0]!.command).toContain('other');
  });

  it('isClaudeCodeHooksInstalled reflects install/uninstall state', () => {
    expect(isClaudeCodeHooksInstalled(settingsPath)).toBe(false);
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    expect(isClaudeCodeHooksInstalled(settingsPath)).toBe(true);
    uninstallClaudeCodeHooks({ hooksPath: settingsPath });
    expect(isClaudeCodeHooksInstalled(settingsPath)).toBe(false);
  });

  it('isClaudeCodeHooksInstalled returns false for malformed settings.json (no throw)', () => {
    writeFileSync(settingsPath, 'this is not json {');
    expect(isClaudeCodeHooksInstalled(settingsPath)).toBe(false);
  });

  it('install with restricted events array only wires those events', () => {
    installClaudeCodeHooks(
      { hooksPath: settingsPath, events: ['UserPromptSubmit'] },
      HOOK_BIN,
    );
    const cfg = readSettings();
    const hooks = cfg['hooks'] as Record<string, unknown>;
    expect(hooks['UserPromptSubmit']).toBeDefined();
    expect(hooks['Stop']).toBeUndefined();
  });
});

/**
 * Regression: the installer used to write `process.execPath` — the absolute
 * path of whatever node ran it — as the hook interpreter. When that node was
 * upgraded or uninstalled (homebrew Cellar, an nvm version dir), every hook
 * invocation printed "No such file or directory", helm silently stopped
 * capturing, and the noise buried real errors in the agent's output.
 */
describe('hook command interpreter', () => {
  it('does NOT bake the installing process node path into the command', () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    for (const event of ALL_CLAUDE_EVENTS) {
      expect(helmCommand(event)).not.toContain(process.execPath);
    }
  });

  it('runs the hook through the helm launcher, which lives under HELM_HOME', () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    const launcher = hookLauncherPath(helmHome);
    expect(helmCommand()).toBe(`'${launcher}' '${HOOK_BIN}' --event 'UserPromptSubmit'`);
    expect(existsSync(launcher)).toBe(true);
  });

  it('re-install is byte-identical — a working config is never churned', () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    const first = readFileSync(settingsPath, 'utf8');
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    expect(readFileSync(settingsPath, 'utf8')).toBe(first);
  });
});

describe('repairClaudeCodeHookCommands', () => {
  /** Settings as an older helm build wrote them: absolute, now-dead node. */
  function seedLegacyInstall(nodePath = '/opt/homebrew/Cellar/node/26.0.0/bin/node'): void {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{
          type: 'command',
          command: `'${nodePath}' '${HOOK_BIN}' --event 'UserPromptSubmit'`,
          timeout: 60,
        }] }],
        Stop: [{ hooks: [{
          type: 'command',
          command: `'${nodePath}' '${HOOK_BIN}' --event 'Stop'`,
          timeout: 60,
        }] }],
      },
    }, null, 2));
  }

  it('rewrites a dead absolute node path to go through the launcher', () => {
    seedLegacyInstall();
    const r = repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN);
    expect(r.repaired).toBe(true);
    for (const event of ['UserPromptSubmit', 'Stop']) {
      expect(helmCommand(event)).toContain(hookLauncherPath(helmHome));
      expect(helmCommand(event)).not.toContain('/opt/homebrew/Cellar');
    }
  });

  it('repairs a hand-edited bare `node` command too (the user\'s stopgap)', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{
          type: 'command',
          command: `node '${HOOK_BIN}' --event 'Stop'`,
          timeout: 60,
        }] }],
      },
    }, null, 2));
    expect(repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN).repaired).toBe(true);
    expect(helmCommand('Stop')).toContain(hookLauncherPath(helmHome));
  });

  it('is a no-op on an already-current config — file untouched byte for byte', () => {
    installClaudeCodeHooks({ hooksPath: settingsPath }, HOOK_BIN);
    const before = readFileSync(settingsPath, 'utf8');
    const r = repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN);
    expect(r.repaired).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('never installs hooks for a user who has none (no settings file)', () => {
    expect(repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN).repaired).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('never installs hooks into a settings file that has no helm entries', () => {
    const foreign = JSON.stringify({
      theme: 'dark',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-tool' }] }] },
    }, null, 2);
    writeFileSync(settingsPath, foreign);
    expect(repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN).repaired).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(foreign);
  });

  it('does not widen a partial install — repairing UserPromptSubmit leaves Stop unwired', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{
          type: 'command',
          command: `'/dead/node' '${HOOK_BIN}' --event 'UserPromptSubmit'`,
        }] }],
      },
    }, null, 2));
    expect(repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN).repaired).toBe(true);
    const hooks = readSettings()['hooks'] as Record<string, unknown>;
    expect(hooks['UserPromptSubmit']).toBeDefined();
    expect(hooks['Stop']).toBeUndefined();
  });

  it('preserves other tools\' hooks while repairing helm\'s', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/usr/local/bin/other-tool' }] },
          { hooks: [{ type: 'command', command: `'/dead/node' '${HOOK_BIN}' --event 'Stop'` }] },
        ],
      },
    }, null, 2));
    repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN);
    const groups = (readSettings()['hooks'] as Record<string, unknown>)['Stop'] as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(groups.flatMap((g) => g.hooks).map((h) => h.command))
      .toContain('/usr/local/bin/other-tool');
    expect(helmCommand('Stop')).toContain(hookLauncherPath(helmHome));
  });

  it('malformed settings.json: reports, does not throw, does not clobber', () => {
    writeFileSync(settingsPath, 'not json {');
    const r = repairClaudeCodeHookCommands({ hooksPath: settingsPath }, HOOK_BIN);
    expect(r.repaired).toBe(false);
    expect(r.reason).toContain('unreadable');
    expect(readFileSync(settingsPath, 'utf8')).toBe('not json {');
  });
});
