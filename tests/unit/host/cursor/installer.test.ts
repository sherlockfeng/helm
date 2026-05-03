import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_CURSOR_EVENTS,
  installCursorHooks,
  readHooksConfig,
  uninstallCursorHooks,
} from '../../../../src/host/cursor/installer.js';

let tmpDir: string;
let hooksPath: string;
const HOOK_BIN = '/abs/path/to/helm-hook';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-installer-'));
  hooksPath = join(tmpDir, 'hooks.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readHooks(): Record<string, unknown> {
  return JSON.parse(readFileSync(hooksPath, 'utf8'));
}

describe('installCursorHooks', () => {
  it('writes a fresh hooks.json with all 10 events', () => {
    const result = installCursorHooks({ hooksPath }, HOOK_BIN);
    expect(result.events).toEqual([...ALL_CURSOR_EVENTS]);
    const cfg = readHooks();
    expect(cfg['version']).toBe(1);
    for (const event of ALL_CURSOR_EVENTS) {
      const arr = (cfg['hooks'] as Record<string, unknown>)[event] as unknown[];
      expect(arr).toHaveLength(1);
    }
  });

  it('hook command embeds the helm-hook path and event name', () => {
    installCursorHooks({ hooksPath }, HOOK_BIN);
    const cfg = readHooks();
    const entry = ((cfg['hooks'] as Record<string, unknown>)['preToolUse'] as Array<{ command: string }>)[0];
    expect(entry?.command).toContain(HOOK_BIN);
    expect(entry?.command).toContain('preToolUse');
  });

  it('preToolUse entry has the matcher; stop entry has loop_limit: null', () => {
    installCursorHooks({ hooksPath }, HOOK_BIN);
    const cfg = readHooks();
    const pre = ((cfg['hooks'] as Record<string, unknown>)['preToolUse'] as Array<{ matcher?: string }>)[0];
    expect(pre?.matcher).toContain('Shell');
    expect(pre?.matcher).toContain('mcp__');

    const stop = ((cfg['hooks'] as Record<string, unknown>)['stop'] as Array<{ loop_limit?: unknown }>)[0];
    expect(stop?.loop_limit).toBeNull();
  });

  it('respects custom timeout', () => {
    installCursorHooks({ hooksPath, timeoutSeconds: 60 }, HOOK_BIN);
    const cfg = readHooks();
    const entry = ((cfg['hooks'] as Record<string, unknown>)['sessionStart'] as Array<{ timeout: number }>)[0];
    expect(entry?.timeout).toBe(60);
  });

  it('only installs the requested events when events option provided', () => {
    installCursorHooks({ hooksPath, events: ['sessionStart'] }, HOOK_BIN);
    const cfg = readHooks();
    expect(Object.keys(cfg['hooks'] as object)).toEqual(['sessionStart']);
  });

  it('is idempotent: re-installing replaces helm entries without duplication', () => {
    installCursorHooks({ hooksPath }, HOOK_BIN);
    installCursorHooks({ hooksPath }, HOOK_BIN);
    const cfg = readHooks();
    for (const event of ALL_CURSOR_EVENTS) {
      const arr = (cfg['hooks'] as Record<string, unknown>)[event] as unknown[];
      expect(arr).toHaveLength(1);
    }
  });

  it('preserves user-added (non-helm) hook entries', () => {
    const userHook = { command: 'do user thing', timeout: 10 };
    writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: { preToolUse: [userHook] },
    }));

    installCursorHooks({ hooksPath }, HOOK_BIN);
    const cfg = readHooks();
    const pre = (cfg['hooks'] as Record<string, unknown>)['preToolUse'] as Array<{ command: string }>;
    expect(pre).toHaveLength(2);
    expect(pre.some((e) => e.command === 'do user thing')).toBe(true);
    expect(pre.some((e) => e.command.includes(HOOK_BIN))).toBe(true);
  });

  it('attack: malformed JSON in existing hooks.json throws a clear error', () => {
    writeFileSync(hooksPath, '{not json');
    expect(() => installCursorHooks({ hooksPath }, HOOK_BIN)).toThrow(/invalid JSON/);
  });

  it('attack: array root in hooks.json is rejected', () => {
    writeFileSync(hooksPath, '[]');
    expect(() => installCursorHooks({ hooksPath }, HOOK_BIN)).toThrow(/JSON object/);
  });

  it('attack: hooks field that is an array is reset to empty', () => {
    writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: [] }));
    installCursorHooks({ hooksPath, events: ['sessionStart'] }, HOOK_BIN);
    const cfg = readHooks();
    expect((cfg['hooks'] as Record<string, unknown>)['sessionStart']).toBeDefined();
  });
});

describe('uninstallCursorHooks', () => {
  it('removes only helm-marked entries', () => {
    const userHook = { command: 'user thing' };
    writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: { preToolUse: [userHook] },
    }));
    installCursorHooks({ hooksPath }, HOOK_BIN);
    uninstallCursorHooks({ hooksPath });
    const cfg = readHooks();
    const pre = (cfg['hooks'] as Record<string, unknown>)['preToolUse'] as Array<{ command: string }>;
    expect(pre).toHaveLength(1);
    expect(pre[0]?.command).toBe('user thing');
  });

  it('uninstall removes empty event arrays', () => {
    installCursorHooks({ hooksPath, events: ['sessionStart'] }, HOOK_BIN);
    uninstallCursorHooks({ hooksPath });
    const cfg = readHooks();
    expect((cfg['hooks'] as Record<string, unknown>)['sessionStart']).toBeUndefined();
  });

  it('attack: uninstall on missing hooks.json is a no-op (creates empty config)', () => {
    expect(() => uninstallCursorHooks({ hooksPath })).not.toThrow();
    const cfg = readHooks();
    expect(cfg['hooks']).toEqual({});
  });

  it('attack: only specified events get uninstalled', () => {
    installCursorHooks({ hooksPath }, HOOK_BIN);
    uninstallCursorHooks({ hooksPath, events: ['sessionStart'] });
    const cfg = readHooks();
    expect((cfg['hooks'] as Record<string, unknown>)['sessionStart']).toBeUndefined();
    expect((cfg['hooks'] as Record<string, unknown>)['preToolUse']).toBeDefined();
  });
});

describe('readHooksConfig', () => {
  it('returns empty config when file is absent', () => {
    expect(readHooksConfig(hooksPath)).toEqual({ version: 1, hooks: {} });
  });
});
