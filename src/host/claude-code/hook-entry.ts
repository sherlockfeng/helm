/**
 * Claude Code hook subprocess entrypoint.
 *
 *   stdin (raw Claude hook payload JSON)
 *     → normalize via claude payload schema
 *     → bridge UDS request(s)  (Stop fires two: agent_response then stop)
 *     → stdout (Claude-shaped JSON response, always allow)
 *
 * Claude expects a JSON response on stdout for every hook invocation. Helm
 * never blocks Claude — we only OBSERVE. So we always return `{}` (or a
 * minimal "continue" response), regardless of whether the bridge round-trip
 * succeeded.
 *
 * Errors here are non-fatal by design: if the bridge socket is missing,
 * the transcript is unreadable, or anything else fails, we still return
 * an empty allow response and Claude's session continues uninterrupted.
 * That keeps "I installed helm" from ever breaking the user's claude flow.
 */

import type { Readable, Writable } from 'node:stream';
import { sendBridgeMessage, bridgeSocketExists } from '../../bridge/client.js';
import { DEFAULT_TIMEOUTS, PATHS } from '../../constants.js';
import { eventToBridgeRequest } from '../cursor/bridge-mapper.js';
import { parseJsonObject, readStdin, writeJson } from '../cursor/io.js';
import {
  buildAgentResponseFromTranscript,
  isClaudeHookEvent,
  normalizeClaudePayload,
} from './normalize.js';
import { readLastAssistantMessage } from './transcript.js';

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
  env?: NodeJS.ProcessEnv;
}

export async function runHook(options: RunHookOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const socketPath = options.socketPath ?? env['HELM_BRIDGE_SOCKET'] ?? PATHS.bridgeSocket;
  const timeoutMs = bridgeTimeout(env);

  const args = parseArgs(argv);
  const raw = await readStdin(stdin);
  const payload = parseJsonObject(raw);
  const eventName = args.event
    || (typeof payload['hook_event_name'] === 'string' ? (payload['hook_event_name'] as string) : '');

  // Always emit an allow/empty response, no matter what fails below.
  // The bridge round-trip is best-effort observation.
  try {
    if (isClaudeHookEvent(eventName) && bridgeSocketExists(socketPath)) {
      const primary = normalizeClaudePayload(payload, eventName);
      const primaryReq = eventToBridgeRequest(primary);
      if (primaryReq) {
        await sendBridgeMessage(primaryReq, { socketPath, timeoutMs })
          .catch(() => { /* swallow; never break claude */ });
      }

      // Stop hooks fire after the assistant finishes — tail the transcript
      // to recover the response text, send agent_response BEFORE stop so
      // helm's per-session state has the response when stop closes it out.
      if (eventName === 'Stop') {
        const transcriptPath = typeof payload['transcript_path'] === 'string'
          ? (payload['transcript_path'] as string)
          : '';
        const text = transcriptPath ? readLastAssistantMessage(transcriptPath) : null;
        if (text) {
          const respEv = buildAgentResponseFromTranscript(payload, text);
          const respReq = eventToBridgeRequest(respEv);
          if (respReq) {
            await sendBridgeMessage(respReq, { socketPath, timeoutMs })
              .catch(() => { /* swallow */ });
          }
        }
      }
    }
  } catch {
    // Catch any sync throws — helm hooks must never break the user's session.
  }

  // Empty response — claude treats no decision as "continue normally".
  writeJson({}, stdout);
}

function bridgeTimeout(env: NodeJS.ProcessEnv): number {
  const fromEnv = Number(env['HELM_BRIDGE_TIMEOUT_MS']);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TIMEOUTS.bridgeMs;
}
