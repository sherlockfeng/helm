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
export function defaultHookBinPath(): string {
  // npm bin dir is the canonical location once installed; fall back to repo bin/ for dev.
  // The `bin` field in package.json points Cursor at this script via $PATH, but Cursor
  // hooks need an absolute path.
  // For now, infer from process.execPath's directory neighborhood; tests inject their own.
  return path.join(path.dirname(process.execPath), 'helm-hook');
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
