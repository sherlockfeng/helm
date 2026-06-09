import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_CLAUDE_EVENTS,
  installClaudeCodeHooks,
  isClaudeCodeHooksInstalled,
  uninstallClaudeCodeHooks,
} from '../../../../src/host/claude-code/installer.js';

let tmpDir: string;
let settingsPath: string;
const HOOK_BIN = '/abs/path/to/helm-hook-claude';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-claude-installer-'));
  settingsPath = join(tmpDir, 'settings.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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
