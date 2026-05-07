/**
 * Reads / writes Cursor's `~/.cursor/hooks.json` to register the Helm hook
 * subprocess. TS port of agent2lark-cursor/src/installer.js.
 *
 * Each hook entry is tagged with HOOK_MARKER ('helm-hook') so we can re-install
 * idempotently without clobbering hooks the user added by hand or that another
 * tool installed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HOOK_MARKER, PATHS } from '../../constants.js';
import type { HostInstallOptions, HostInstallResult } from '../types.js';

/** Cursor hook events that map to host_approval_request (intercept points). */
export const APPROVAL_EVENTS = ['beforeShellExecution', 'beforeMCPExecution', 'preToolUse'] as const;

/** Cursor hook events that map to host_session_start / prompt_submit / progress / stop / agent_response. */
export const RELAY_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'afterAgentResponse',
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'stop',
] as const;

export const ALL_CURSOR_EVENTS = [...APPROVAL_EVENTS, ...RELAY_EVENTS] as const;

interface HookEntry {
  command: string;
  timeout?: number;
  failClosed?: boolean;
  matcher?: string;
  loop_limit?: number | null;
}

interface HooksConfig {
  version: number;
  hooks: Record<string, HookEntry[]>;
}

interface InstallContext {
  hooksPath: string;
  hookBinPath: string;
  events: readonly string[];
  timeoutSeconds: number;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hookCommand(hookBinPath: string, event: string): string {
  // Use absolute Node binary path so PATH lookup never matters from Cursor's spawn env.
  return `${quote(process.execPath)} ${quote(hookBinPath)} --event ${quote(event)}`;
}

export function readHooksConfig(hooksPath: string): HooksConfig {
  if (!existsSync(hooksPath)) return { version: 1, hooks: {} };

  const raw = readFileSync(hooksPath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`${hooksPath} contains invalid JSON: ${(err as Error).message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${hooksPath} must contain a JSON object`);
  }

  const config = parsed as Record<string, unknown>;
  const version = typeof config['version'] === 'number' ? config['version'] : 1;
  const hooksField = config['hooks'];
  const hooks: Record<string, HookEntry[]> = {};
  if (hooksField && typeof hooksField === 'object' && !Array.isArray(hooksField)) {
    for (const [event, entries] of Object.entries(hooksField as Record<string, unknown>)) {
      if (Array.isArray(entries)) hooks[event] = entries as HookEntry[];
    }
  }
  return { version, hooks };
}

function writeHooksConfig(config: HooksConfig, hooksPath: string): void {
  mkdirSync(path.dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function isHelmHook(entry: HookEntry): boolean {
  return typeof entry?.command === 'string' && entry.command.includes(HOOK_MARKER);
}

function removeHelmFromEvent(config: HooksConfig, event: string): void {
  const arr = config.hooks[event];
  if (!Array.isArray(arr)) return;
  const filtered = arr.filter((entry) => !isHelmHook(entry));
  if (filtered.length === 0) delete config.hooks[event];
  else config.hooks[event] = filtered;
}

function desiredHook(ctx: InstallContext, event: string): HookEntry {
  const hook: HookEntry = {
    command: hookCommand(ctx.hookBinPath, event),
    timeout: ctx.timeoutSeconds,
    failClosed: false,
  };
  if (event === 'preToolUse') {
    hook.matcher = 'Shell|Bash|Write|Edit|Delete|ApplyPatch|MultiEdit|MCP:.*|mcp__.*';
  }
  if (event === 'stop') {
    hook.loop_limit = null;
  }
  return hook;
}

/** Resolve the path to the helm-hook bin script. Allow override for tests. */
export function defaultHookBinPath(env: NodeJS.ProcessEnv = process.env): string {
  // Cursor hooks need an absolute path because the spawn env may not have
  // the user's PATH wired (Cursor launches GUI-style). Search in priority:
  //
  //   1. HELM_HOOK_BIN env override — for packaged installs / advanced users
  //   2. Repo's bin/helm-hook.mjs (resolved from this module's URL) — works
  //      out-of-the-box for everyone running from a clone, no `pnpm link --global`
  //      needed
  //   3. The npm/global bin neighbour of process.execPath — only relevant once
  //      helm is published & installed globally
  //
  // The previous implementation used (3) only, which silently broke for every
  // dev not running `pnpm link --global` — Cursor would invoke a non-existent
  // path and fail closed (failClosed: false) with no UI signal.
  const fromEnv = env['HELM_HOOK_BIN'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const repoBin = resolveRepoHookBin();
  if (repoBin && existsSync(repoBin)) return repoBin;

  return path.join(path.dirname(process.execPath), 'helm-hook');
}

/**
 * Walk up from this compiled module to find `<repo>/bin/helm-hook.mjs`.
 * Works whether called from `dist/cli/index.js` (esm bundle) or directly
 * from src under tsx / vitest. Returns null when nothing matches — caller
 * falls back to the global-bin guess.
 */
function resolveRepoHookBin(): string | null {
  let here: string;
  try {
    here = fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
  let dir = path.dirname(here);
  // Walk up at most 6 levels looking for a sibling bin/helm-hook.mjs.
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'bin', 'helm-hook.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function installCursorHooks(options: HostInstallOptions = {}, hookBinPath?: string): HostInstallResult {
  const hooksPath = options.hooksPath ?? PATHS.cursorHooks;
  const events = options.events?.length ? options.events : (ALL_CURSOR_EVENTS as readonly string[]);
  const ctx: InstallContext = {
    hooksPath,
    hookBinPath: hookBinPath ?? defaultHookBinPath(),
    events,
    timeoutSeconds: options.timeoutSeconds ?? 86_400,
  };

  const config = readHooksConfig(hooksPath);
  for (const event of events) {
    removeHelmFromEvent(config, event);
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
    config.hooks[event]!.push(desiredHook(ctx, event));
  }
  writeHooksConfig(config, hooksPath);
  return { hooksPath, events: [...events] };
}

export function uninstallCursorHooks(options: HostInstallOptions = {}): HostInstallResult {
  const hooksPath = options.hooksPath ?? PATHS.cursorHooks;
  const config = readHooksConfig(hooksPath);
  const events = options.events?.length ? options.events : Object.keys(config.hooks);

  for (const event of events) {
    removeHelmFromEvent(config, event);
  }
  writeHooksConfig(config, hooksPath);
  return { hooksPath, events: [...events] };
}
