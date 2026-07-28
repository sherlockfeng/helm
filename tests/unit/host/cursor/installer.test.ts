import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_CURSOR_EVENTS,
  defaultHookBinPath,
  installCursorHooks,
  readHooksConfig,
  repairCursorHookCommands,
  uninstallCursorHooks,
} from '../../../../src/host/cursor/installer.js';
import { hookLauncherPath } from '../../../../src/host/hook-launcher.js';

let tmpDir: string;
let hooksPath: string;
let helmHome: string;
let previousHelmHome: string | undefined;
const HOOK_BIN = '/abs/path/to/helm-hook';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-installer-'));
  hooksPath = join(tmpDir, 'hooks.json');
  // Keep the generated launcher out of the developer's real ~/.helm.
  helmHome = join(tmpDir, '.helm');
  previousHelmHome = process.env['HELM_HOME'];
  process.env['HELM_HOME'] = helmHome;
});

afterEach(() => {
  if (previousHelmHome === undefined) delete process.env['HELM_HOME'];
  else process.env['HELM_HOME'] = previousHelmHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The helm command wired onto `event`. */
function helmCommand(event: string): string {
  const entries = (readHooks()['hooks'] as Record<string, Array<{ command: string }>>)[event]!;
  return entries.find((e) => e.command.includes('helm-hook'))!.command;
}

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

describe('defaultHookBinPath (Phase 33)', () => {
  it('respects HELM_HOOK_BIN override', () => {
    expect(defaultHookBinPath({ HELM_HOOK_BIN: '/custom/path/to/hook' }))
      .toBe('/custom/path/to/hook');
  });

  it('whitespace-only HELM_HOOK_BIN is ignored — falls back to repo bin', () => {
    const got = defaultHookBinPath({ HELM_HOOK_BIN: '   ' });
    expect(got).toMatch(/bin\/helm-hook\.mjs$/);
  });

  it('without HELM_HOOK_BIN, resolves to the repo bin/helm-hook.mjs sibling', () => {
    // Tests run from the repo, so the resolver should land on bin/helm-hook.mjs.
    const got = defaultHookBinPath({});
    expect(got).toMatch(/bin\/helm-hook\.mjs$/);
    // Must be absolute so Cursor's spawn env can find it without PATH.
    expect(got.startsWith('/')).toBe(true);
  });

  it('attack: empty env (no override, no PATH) still returns a string, never throws', () => {
    expect(() => defaultHookBinPath({})).not.toThrow();
  });
});


/**
 * Same regression as the Claude installer: `process.execPath` baked into the
 * command dies with the node that installed it. See src/host/hook-launcher.ts.
 */
describe('cursor hook command interpreter', () => {
  it('does NOT bake the installing process node path into any command', () => {
    installCursorHooks({ hooksPath }, HOOK_BIN);
    for (const event of ALL_CURSOR_EVENTS) {
      expect(helmCommand(event)).not.toContain(process.execPath);
      expect(helmCommand(event)).toContain(hookLauncherPath(helmHome));
    }
  });

  it('keeps the per-event extras (preToolUse matcher, stop loop_limit)', () => {
    installCursorHooks({ hooksPath }, HOOK_BIN);
    const hooks = readHooks()['hooks'] as Record<string, Array<Record<string, unknown>>>;
    expect(hooks['preToolUse']![0]!['matcher']).toBeTruthy();
    expect(hooks['stop']![0]!['loop_limit']).toBeNull();
  });

  it('re-install is byte-identical — a working config is never churned', () => {
    installCursorHooks({ hooksPath }, HOOK_BIN);
    const first = readFileSync(hooksPath, 'utf8');
    installCursorHooks({ hooksPath }, HOOK_BIN);
    expect(readFileSync(hooksPath, 'utf8')).toBe(first);
  });
});

describe('repairCursorHookCommands', () => {
  it('rewrites a dead absolute node path to go through the launcher', () => {
    writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: {
        stop: [{ command: `'/opt/homebrew/Cellar/node/26.0.0/bin/node' '${HOOK_BIN}' --event 'stop'` }],
      },
    }, null, 2));
    expect(repairCursorHookCommands({ hooksPath }, HOOK_BIN).repaired).toBe(true);
    expect(helmCommand('stop')).toContain(hookLauncherPath(helmHome));
  });

  it('is a no-op on a current config, and never installs for a user with none', () => {
    expect(repairCursorHookCommands({ hooksPath }, HOOK_BIN).repaired).toBe(false);
    installCursorHooks({ hooksPath }, HOOK_BIN);
    const before = readFileSync(hooksPath, 'utf8');
    expect(repairCursorHookCommands({ hooksPath }, HOOK_BIN).repaired).toBe(false);
    expect(readFileSync(hooksPath, 'utf8')).toBe(before);
  });

  it('leaves foreign hooks alone and does not widen the event set', () => {
    writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: {
        stop: [
          { command: '/usr/local/bin/other-tool' },
          { command: `'/dead/node' '${HOOK_BIN}' --event 'stop'` },
        ],
      },
    }, null, 2));
    repairCursorHookCommands({ hooksPath }, HOOK_BIN);
    const cfg = readHooks()['hooks'] as Record<string, Array<{ command: string }>>;
    expect(cfg['stop']!.map((e) => e.command)).toContain('/usr/local/bin/other-tool');
    expect(Object.keys(cfg)).toEqual(['stop']);
  });

  it('malformed hooks.json: reports, does not throw, does not clobber', () => {
    writeFileSync(hooksPath, 'not json {');
    const r = repairCursorHookCommands({ hooksPath }, HOOK_BIN);
    expect(r.repaired).toBe(false);
    expect(r.reason).toContain('unreadable');
    expect(readFileSync(hooksPath, 'utf8')).toBe('not json {');
  });
});
