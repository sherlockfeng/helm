/**
 * Cursor hook payload → typed HostEvent.
 *
 * TS port of agent2lark-cursor/src/normalize.js. The Cursor hook payload is
 * defensively typed because its field names varied across versions
 * (snake_case ↔ camelCase, multiple aliases for prompt / cwd / sessionId).
 */

import type {
  HostAgentResponseEvent,
  HostEvent,
  HostPromptSubmitEvent,
  HostSessionStartEvent,
  HostStopEvent,
  HostToolUsePostEvent,
  HostToolUsePreEvent,
} from '../types.js';

const RAW_OBJECT = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function firstObject(...values: unknown[]): Record<string, unknown> {
  for (const v of values) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return {};
}

function normalizeToolName(name: string): string {
  if (!name) return 'unknown';
  if (name.startsWith('MCP:')) {
    return `mcp__${name.slice(4).trim().replace(/[^\w.-]+/g, '__')}`;
  }
  return name;
}

function lowerEvent(input: Record<string, unknown>, explicitEvent?: string): string {
  const ev = firstString(
    explicitEvent,
    input['hook_event_name'],
    input['hookEventName'],
    input['event_name'],
    input['eventName'],
    input['event'],
    input['type'],
  );
  return ev.toLowerCase();
}

function rawEventName(input: Record<string, unknown>, explicitEvent?: string): string {
  return firstString(
    explicitEvent,
    input['hook_event_name'],
    input['hookEventName'],
    input['event_name'],
    input['eventName'],
    input['event'],
    input['type'],
  );
}

function getCwd(input: Record<string, unknown>): string {
  // Cursor 3.3+ ships an array `workspace_roots` (per the live debug capture);
  // older payloads / other hosts still use the singular forms. Take the first
  // element of an array — multi-root workspaces are rare and the first entry
  // is the canonical project root in Cursor's UI.
  const roots = input['workspace_roots'] ?? input['workspaceRoots'];
  if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === 'string' && roots[0]) {
    return roots[0];
  }
  return firstString(
    input['cwd'],
    input['working_directory'],
    input['workingDirectory'],
    input['workspace_path'],
    input['workspacePath'],
    input['workspace_root'],
    input['workspaceRoot'],
    input['project_root'],
    input['projectRoot'],
  );
}

function getSessionId(input: Record<string, unknown>): string {
  return firstString(
    input['session_id'],
    input['sessionId'],
    input['conversation_id'],
    input['conversationId'],
    input['thread_id'],
    input['threadId'],
    process.env['CURSOR_SESSION_ID'],
  );
}

function getPrompt(input: Record<string, unknown>): string {
  return firstString(input['prompt'], input['message'], input['text']);
}

function getAssistantText(input: Record<string, unknown>): string {
  return firstString(
    input['text'],
    input['agent_message'],
    input['assistant_message'],
    input['response'],
  );
}

function getDurationMs(input: Record<string, unknown>): number | undefined {
  const value = input['duration_ms'] ?? input['durationMs'] ?? input['duration'];
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function getExitCode(input: Record<string, unknown>): number | undefined {
  const value = input['exit_code'] ?? input['exitCode'] ?? input['code'];
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

interface MappedTool {
  toolName: string;
  toolInput: Record<string, unknown>;
}

function buildShellInput(input: Record<string, unknown>): MappedTool {
  const nested = firstObject(input['tool_input'], input['toolInput'], input['input']);
  const command = firstString(
    input['command'],
    input['shell_command'],
    input['shellCommand'],
    nested['command'],
  );
  return {
    toolName: 'Shell',
    toolInput: {
      command,
      description: firstString(input['description'], nested['description']),
      working_directory: getCwd(input),
    },
  };
}

function buildMcpInput(input: Record<string, unknown>): MappedTool {
  const nested = firstObject(input['tool_input'], input['toolInput'], input['input']);
  const args = firstObject(input['arguments'], input['args'], nested['arguments'], nested['args'], nested['input']);
  const server = firstString(input['server'], input['serverName'], input['mcp_server'], nested['server'], nested['serverName']);
  const tool = firstString(input['toolName'], input['tool_name'], input['name'], input['tool'], nested['toolName'], nested['name']);
  const suffix = [server, tool].filter(Boolean).join('__').replace(/[^\w.-]+/g, '__');
  return {
    toolName: suffix ? `mcp__${suffix}` : 'mcp__unknown',
    toolInput: { server, tool, arguments: args },
  };
}

function buildGenericTool(input: Record<string, unknown>): MappedTool {
  const nested = firstObject(input['tool_input'], input['toolInput'], input['input']);
  const rawToolName = firstString(
    input['tool_name'],
    input['toolName'],
    input['name'],
    input['tool'],
    input['toolType'],
    nested['tool_name'],
    nested['toolName'],
    nested['name'],
  );
  return {
    toolName: normalizeToolName(rawToolName),
    toolInput: firstObject(
      input['tool_input'],
      input['toolInput'],
      input['input'],
      input['arguments'],
      input['args'],
    ),
  };
}

const PATH_FIELD_NAMES = [
  'path', 'target_file', 'targetFile', 'file_path', 'filePath', 'filepath',
  'absolute_path', 'absolutePath', 'notebook_path', 'notebookPath', 'target', 'uri',
];
const PATH_COLLECTION_FIELD_NAMES = ['edits', 'changes', 'files', 'operations', 'items'];

function pathFromPatchText(value: unknown): string {
  const text = String(value ?? '');
  if (!text) return '';
  for (const line of text.split(/\r?\n/)) {
    const apply = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/);
    if (apply) return apply[1]!.trim();
    const diff = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/);
    if (diff) {
      const candidate = diff[1]!.trim();
      if (candidate && candidate !== '/dev/null') return candidate;
    }
  }
  return '';
}

function firstPathFromToolInput(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (!value || typeof value !== 'object') return '';
  if (seen.has(value as object)) return '';
  seen.add(value as object);
  const obj = value as Record<string, unknown>;

  const direct = firstString(...PATH_FIELD_NAMES.map((f) => obj[f]));
  if (direct) return direct;

  const patchPath = pathFromPatchText(firstString(obj['patch'], obj['diff']));
  if (patchPath) return patchPath;

  for (const field of PATH_COLLECTION_FIELD_NAMES) {
    const nested = obj[field];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const p = firstPathFromToolInput(item, seen);
        if (p) return p;
      }
    } else {
      const p = firstPathFromToolInput(nested, seen);
      if (p) return p;
    }
  }
  return '';
}

function getToolCommand(toolName: string, toolInput: Record<string, unknown>): string {
  if (!toolInput) return '';
  if (toolName === 'Shell' || toolName === 'Bash') {
    return firstString(toolInput['command']);
  }
  if (toolName.startsWith('mcp__')) {
    const args = toolInput['arguments'];
    return args !== undefined && args !== null ? JSON.stringify(args) : '';
  }
  return firstPathFromToolInput(toolInput);
}

// ── Public API ─────────────────────────────────────────────────────────────

const RELAY_EVENTS = new Set([
  'sessionstart', 'beforesubmitprompt', 'afteragentresponse',
  'posttooluse', 'posttoolusefailure', 'aftershellexecution', 'stop',
]);

const APPROVAL_EVENTS = new Set([
  'beforeshellexecution', 'beforemcpexecution', 'pretooluse',
]);

export function isRelayHookEvent(event: string): boolean {
  return RELAY_EVENTS.has(event.toLowerCase());
}

export function isApprovalHookEvent(event: string): boolean {
  return APPROVAL_EVENTS.has(event.toLowerCase());
}

export interface NormalizeResult {
  event: HostEvent;
  /** Unrecognized event flag — caller may want to no-op rather than send to bridge. */
  unknown: boolean;
}

export function normalizeCursorEvent(rawInput: unknown, explicitEvent?: string): NormalizeResult {
  const input = RAW_OBJECT(rawInput);
  const lower = lowerEvent(input, explicitEvent);
  const cwd = getCwd(input);
  const hostSessionId = getSessionId(input);

  const base = { host: 'cursor' as const, hostSessionId, cwd: cwd || undefined, raw: rawInput };

  if (lower === 'sessionstart') {
    const ev: HostSessionStartEvent = {
      ...base,
      kind: 'session_start',
      composerMode: firstString(input['composer_mode'], input['composerMode']) || undefined,
    };
    return { event: ev, unknown: false };
  }

  if (lower === 'beforesubmitprompt') {
    const ev: HostPromptSubmitEvent = { ...base, kind: 'prompt_submit', prompt: getPrompt(input) };
    return { event: ev, unknown: false };
  }

  if (lower === 'afteragentresponse') {
    const ev: HostAgentResponseEvent = { ...base, kind: 'agent_response', text: getAssistantText(input) };
    return { event: ev, unknown: false };
  }

  if (lower === 'stop') {
    const loopRaw = input['loop_count'] ?? input['loopCount'];
    const loopCount = loopRaw !== undefined ? Number(loopRaw) : undefined;
    const ev: HostStopEvent = {
      ...base,
      kind: 'stop',
      loopCount: Number.isFinite(loopCount) ? loopCount : undefined,
      status: firstString(input['status']) || undefined,
    };
    return { event: ev, unknown: false };
  }

  if (lower === 'aftershellexecution') {
    const exitCode = getExitCode(input);
    const ev: HostToolUsePostEvent = {
      ...base,
      kind: 'tool_use_post',
      tool: 'Shell',
      command: firstString(input['command'], input['shell_command'], input['shellCommand']),
      phase: exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed',
      exitCode,
      durationMs: getDurationMs(input),
    };
    return { event: ev, unknown: false };
  }

  if (lower === 'posttooluse' || lower === 'posttoolusefailure') {
    const mapped = buildGenericTool(input);
    const ev: HostToolUsePostEvent = {
      ...base,
      kind: 'tool_use_post',
      tool: mapped.toolName,
      command: getToolCommand(mapped.toolName, mapped.toolInput),
      phase: lower === 'posttoolusefailure' ? 'failed' : 'completed',
      exitCode: getExitCode(input),
      durationMs: getDurationMs(input),
    };
    return { event: ev, unknown: false };
  }

  if (APPROVAL_EVENTS.has(lower)) {
    let mapped: MappedTool;
    if (lower === 'beforeshellexecution') mapped = buildShellInput(input);
    else if (lower === 'beforemcpexecution') mapped = buildMcpInput(input);
    else mapped = buildGenericTool(input);

    const ev: HostToolUsePreEvent = {
      ...base,
      kind: 'tool_use_pre',
      hookEventName: rawEventName(input, explicitEvent) || 'preToolUse',
      tool: mapped.toolName,
      command: getToolCommand(mapped.toolName, mapped.toolInput),
      payload: mapped.toolInput,
      permissionMode: firstString(input['permission_mode'], input['permissionMode']) || undefined,
    };
    return { event: ev, unknown: false };
  }

  // Unknown event — synthesize a minimal session_start so callers have something
  // typed; flag it so the caller can decide to fallback rather than send.
  const ev: HostSessionStartEvent = { ...base, kind: 'session_start' };
  return { event: ev, unknown: true };
}
