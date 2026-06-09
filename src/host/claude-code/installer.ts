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
  events: readonly string[];
  timeoutSeconds: number;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hookCommand(hookBinPath: string, event: string): string {
  // Absolute Node path so PATH lookup never matters — claude code spawns
  // hooks from its own env, which on macOS GUI launches doesn't include
  // the user's shell PATH.
  return `${quote(process.execPath)} ${quote(hookBinPath)} --event ${quote(event)}`;
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
      command: hookCommand(ctx.hookBinPath, event),
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
): HostInstallResult {
  const settingsPath = options.hooksPath ?? PATHS.claudeSettings;
  const events = options.events?.length ? options.events : (ALL_CLAUDE_EVENTS as readonly string[]);
  const ctx: InstallContext = {
    settingsPath,
    hookBinPath: hookBinPath ?? defaultHookBinPath(),
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
