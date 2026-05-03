/**
 * Cursor hook subprocess entrypoint. See PROJECT_BLUEPRINT.md §7.2 / §8.2.
 *
 *   stdin (raw Cursor hook payload JSON)
 *     → normalize via CursorHostAdapter
 *     → eventToBridgeRequest
 *     → sendBridgeMessage (Unix domain socket)
 *     → bridgeResponseToDecision
 *     → adapter.formatResponse
 *     → stdout (Cursor-shaped JSON)
 *
 * On any failure (no socket, timeout, malformed response) we fall back to a
 * conservative decision so we never block Cursor: relay events return
 * `{ continue: true }` / `{}`, approval events return `{ permission: 'ask' }`.
 */

import { sendBridgeMessage, bridgeSocketExists } from '../../bridge/client.js';
import type { Readable, Writable } from 'node:stream';
import { DEFAULT_TIMEOUTS, PATHS } from '../../constants.js';
import { CursorHostAdapter } from './adapter.js';
import { isApprovalHookEvent } from './normalize.js';
import { eventToBridgeRequest, bridgeResponseToDecision, fallbackDecision } from './bridge-mapper.js';
import { isRiskyPreToolUse } from './scope.js';
import { parseJsonObject, readStdin, writeJson } from './io.js';
import type { HostEvent } from '../types.js';

interface ParsedArgs {
  event?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--event') { out.event = argv[i + 1] ?? ''; i++; }
    else if (a.startsWith('--event=')) { out.event = a.slice('--event='.length); }
  }
  return out;
}

export interface RunHookOptions {
  argv?: readonly string[];
  stdin?: Readable;
  stdout?: Writable;
  socketPath?: string;
  /** Override env for timeout decisions. Tests inject a controlled object. */
  env?: NodeJS.ProcessEnv;
}

/** Per-§8.2 — host_stop is a long-poll, host_approval_request can wait 24h. */
function bridgeTimeoutMs(event: HostEvent, env: NodeJS.ProcessEnv): number {
  const fromEnv = Number(env['HELM_BRIDGE_TIMEOUT_MS']);
  const base = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUTS.bridgeMs;

  if (event.kind === 'stop') {
    const waitPoll = Number(env['HELM_WAIT_POLL_MS']);
    const wp = Number.isFinite(waitPoll) && waitPoll > 0 ? waitPoll : DEFAULT_TIMEOUTS.waitPollMs;
    return Math.max(base, wp + 5_000);
  }

  if (event.kind === 'tool_use_pre') {
    const approval = Number(env['HELM_APPROVAL_TIMEOUT_MS']);
    const ap = Number.isFinite(approval) && approval > 0 ? approval : DEFAULT_TIMEOUTS.approvalMs;
    return Math.max(base, ap + 5_000);
  }

  return base;
}

export async function runHook(options: RunHookOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const socketPath = options.socketPath ?? env['HELM_BRIDGE_SOCKET'] ?? PATHS.bridgeSocket;

  const args = parseArgs(argv);
  const raw = await readStdin(stdin);
  const input = parseJsonObject(raw);
  const explicitEvent = args.event
    ?? (typeof input['hook_event_name'] === 'string' ? (input['hook_event_name'] as string) : undefined)
    ?? (typeof input['hookEventName'] === 'string' ? (input['hookEventName'] as string) : undefined)
    ?? (typeof input['event'] === 'string' ? (input['event'] as string) : undefined);

  const adapter = new CursorHostAdapter();
  const event = adapter.normalize(input, explicitEvent);

  // Approval fast-path: low-risk preToolUse never round-trips to the bridge.
  // Only Shell/Bash/Write/Edit/Delete/ApplyPatch/MultiEdit/MCP:* / mcp__* are intercepted.
  if (event.kind === 'tool_use_pre' && !isRiskyPreToolUse(event.tool)) {
    writeJson(adapter.formatResponse(event, {
      kind: 'tool_use_pre', permission: 'allow', reason: 'low-risk tool',
    }), stdout);
    return;
  }

  const request = eventToBridgeRequest(event);
  if (!request) {
    writeJson(adapter.formatResponse(event, fallbackDecision(event)), stdout);
    return;
  }

  if (!bridgeSocketExists(socketPath)) {
    const isApproval = isApprovalHookEvent(explicitEvent ?? '') || event.kind === 'tool_use_pre';
    const reason = isApproval
      ? 'Helm bridge is not running. Please review this Cursor action locally.'
      : undefined;
    writeJson(adapter.formatResponse(event, fallbackDecision(event, reason)), stdout);
    return;
  }

  try {
    const response = await sendBridgeMessage(request, {
      socketPath,
      timeoutMs: bridgeTimeoutMs(event, env),
    });
    writeJson(adapter.formatResponse(event, bridgeResponseToDecision(event, response)), stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeJson(adapter.formatResponse(event, fallbackDecision(event, `bridge error: ${reason}`)), stdout);
  }
}
