/**
 * Reads / writes Claude Code's `~/.claude/settings.json` `hooks` field to
 * register the Helm hook subprocess. Mirrors src/host/cursor/installer.ts
 * but targets Claude Code's hook schema:
 *
 *   {
 *     "hooks": {
 *       "UserPromptSubmit": [
 *         {
 *           "hooks": [
 *             { "type": "command", "command": "<helm-hook-claude bin>", "timeout": 60 }
 *           ]
 *         }
 *       ],
 *       "Stop": [...]
 *     }
 *   }
 *
 * Each helm hook entry is tagged with HOOK_MARKER ('helm-hook') in its
 * command string so we can re-install idempotently without clobbering hooks
 * the user added by hand.
 *
 * UserPromptSubmit captures the user's prompt; Stop fires when the assistant
 * finishes a turn — the hook entry reads the transcript file pointed at by
 * the payload to recover the assistant's last message and emits both the
 * agent_response and stop bridge events.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HOOK_MARKER, PATHS } from '../../constants.js';
import { hookInterpreterPrefix, shellQuote as quote } from '../hook-launcher.js';
import type { HostInstallOptions, HostInstallResult } from '../types.js';

/**
 * Events helm subscribes to. UserPromptSubmit gives us the prompt;
 * Stop gives us a hook into when the assistant finishes (the entry reads
 * the transcript to recover the response text). PreToolUse + PostToolUse
 * would let us also approve/observe tool use — left out of v1 because
 * Claude Code's permission UI already covers it and the renderer doesn't
 * surface per-tool approvals yet.
 */
export const RELAY_EVENTS = ['UserPromptSubmit', 'Stop'] as const;
export const ALL_CLAUDE_EVENTS = [...RELAY_EVENTS] as const;

interface InnerHook {
  type: 'command';
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks: InnerHook[];
}

interface Settings {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

interface InstallContext {
  settingsPath: string;
  hookBinPath: string;
  interpreter: string;
  events: readonly string[];
  timeoutSeconds: number;
}

function hookCommand(ctx: InstallContext, event: string): string {
  // The interpreter is helm's own launcher (see src/host/hook-launcher.ts),
  // NOT process.execPath. Claude Code spawns hooks from its own env, which
  // on macOS GUI launches has no user shell PATH — but baking in the
  // installing process's absolute node path rots the moment that node is
  // upgraded or removed. The launcher resolves node at run time and handles
  // both cases.
  return `${ctx.interpreter} ${quote(ctx.hookBinPath)} --event ${quote(event)}`;
}

function readSettings(settingsPath: string): Settings {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8');
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new Error(`${settingsPath} contains invalid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must contain a JSON object`);
  }
  return parsed as Settings;
}

function writeSettings(settings: Settings, settingsPath: string): void {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function isHelmInner(h: InnerHook): boolean {
  return typeof h?.command === 'string' && h.command.includes(HOOK_MARKER);
}

/** Strip helm-tagged inner hooks from every matcher group on this event. */
function removeHelmFromEvent(settings: Settings, event: string): void {
  if (!settings.hooks) return;
  const groups = settings.hooks[event];
  if (!Array.isArray(groups)) return;
  const cleaned: MatcherGroup[] = [];
  for (const grp of groups) {
    if (!grp || !Array.isArray(grp.hooks)) continue;
    const filtered = grp.hooks.filter((h) => !isHelmInner(h));
    if (filtered.length > 0) cleaned.push({ ...grp, hooks: filtered });
  }
  if (cleaned.length === 0) delete settings.hooks[event];
  else settings.hooks[event] = cleaned;
}

function desiredGroup(ctx: InstallContext, event: string): MatcherGroup {
  return {
    hooks: [{
      type: 'command',
      command: hookCommand(ctx, event),
      timeout: ctx.timeoutSeconds,
    }],
  };
}

/**
 * Resolve the path to `bin/helm-hook-claude.mjs`. Search priority mirrors
 * Cursor's installer:
 *   1. HELM_CLAUDE_HOOK_BIN env override
 *   2. Repo's bin/helm-hook-claude.mjs (resolved from this module's URL)
 *   3. The npm/global bin neighbour of process.execPath
 */
export function defaultHookBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['HELM_CLAUDE_HOOK_BIN'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const repoBin = resolveRepoHookBin();
  if (repoBin && existsSync(repoBin)) return repoBin;

  return path.join(path.dirname(process.execPath), 'helm-hook-claude');
}

function resolveRepoHookBin(): string | null {
  let here: string;
  try { here = fileURLToPath(import.meta.url); }
  catch { return null; }
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'bin', 'helm-hook-claude.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function installClaudeCodeHooks(
  options: HostInstallOptions = {},
  hookBinPath?: string,
  helmHome?: string,
): HostInstallResult {
  const settingsPath = options.hooksPath ?? PATHS.claudeSettings;
  const events = options.events?.length ? options.events : (ALL_CLAUDE_EVENTS as readonly string[]);
  const ctx: InstallContext = {
    settingsPath,
    hookBinPath: hookBinPath ?? defaultHookBinPath(),
    // Writes/refreshes $HELM_HOME/bin/helm-hook-node as a side effect.
    interpreter: hookInterpreterPrefix(helmHome),
    events,
    timeoutSeconds: options.timeoutSeconds ?? 60,
  };

  const settings = readSettings(settingsPath);
  if (!settings.hooks) settings.hooks = {};
  for (const event of events) {
    removeHelmFromEvent(settings, event);
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event]!.push(desiredGroup(ctx, event));
  }
  writeSettings(settings, settingsPath);
  return { hooksPath: settingsPath, events: [...events] };
}

export function uninstallClaudeCodeHooks(options: HostInstallOptions = {}): HostInstallResult {
  const settingsPath = options.hooksPath ?? PATHS.claudeSettings;
  const settings = readSettings(settingsPath);
  const events = options.events?.length
    ? options.events
    : Object.keys(settings.hooks ?? {});

  if (settings.hooks) {
    for (const event of events) removeHelmFromEvent(settings, event);
  }
  writeSettings(settings, settingsPath);
  return { hooksPath: settingsPath, events: [...events] };
}

/**
 * Every helm-tagged command in the settings tree, keyed by the event it is
 * registered on.
 */
function helmCommandsByEvent(settings: Settings): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const grp of groups) {
      if (!Array.isArray(grp?.hooks)) continue;
      for (const h of grp.hooks) {
        if (!isHelmInner(h)) continue;
        const list = out.get(event) ?? [];
        list.push(h.command);
        out.set(event, list);
      }
    }
  }
  return out;
}

/**
 * Self-heal for installs written by older helm builds (and for anything that
 * left a helm hook pointing at an interpreter that no longer exists).
 *
 * Historically the installer wrote `process.execPath` — e.g.
 * `/opt/homebrew/Cellar/node/26.0.0/bin/node` — into the command. Once that
 * node was upgraded away, every hook invocation printed
 * `No such file or directory` and helm silently stopped observing. Hand-
 * editing settings.json didn't help either: the next install rewrote the
 * dead path. So on boot we detect any helm command that isn't driven by the
 * current launcher and re-install, which is idempotent for healthy configs.
 *
 * Only ever repairs — never installs hooks for a user who hasn't opted in.
 */
export function repairClaudeCodeHookCommands(
  options: HostInstallOptions = {},
  hookBinPath?: string,
  helmHome?: string,
): { repaired: boolean; reason?: string } {
  const settingsPath = options.hooksPath ?? PATHS.claudeSettings;
  if (!existsSync(settingsPath)) return { repaired: false };
  let settings: Settings;
  try { settings = readSettings(settingsPath); }
  catch (err) { return { repaired: false, reason: `unreadable: ${(err as Error).message}` }; }

  const byEvent = helmCommandsByEvent(settings);
  if (byEvent.size === 0) return { repaired: false };

  const prefix = hookInterpreterPrefix(helmHome);
  const staleEvents = [...byEvent.entries()]
    .filter(([, cmds]) => cmds.some((cmd) => !cmd.startsWith(`${prefix} `)))
    .map(([event]) => event);
  if (staleEvents.length === 0) return { repaired: false };

  // Rewrite exactly the events that are already wired — a repair must not
  // widen what the user opted into.
  installClaudeCodeHooks(
    { ...options, hooksPath: settingsPath, events: options.events ?? staleEvents },
    hookBinPath,
    helmHome,
  );
  return { repaired: true, reason: `stale interpreter on: ${staleEvents.join(', ')}` };
}

/**
 * True if at least one helm-tagged inner hook is present anywhere in the
 * settings file's hooks tree. Cheap probe for the Settings status pill.
 */
export function isClaudeCodeHooksInstalled(settingsPath: string = PATHS.claudeSettings): boolean {
  if (!existsSync(settingsPath)) return false;
  let settings: Settings;
  try { settings = readSettings(settingsPath); }
  catch { return false; }
  if (!settings.hooks) return false;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const grp of groups) {
      if (!grp?.hooks) continue;
      if (grp.hooks.some(isHelmInner)) return true;
    }
  }
  return false;
}

// Export internals used by tests + status helpers.
export { readSettings as readSettingsFile };
