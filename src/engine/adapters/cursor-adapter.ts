/**
 * Cursor adapter (Phase 68).
 *
 * Capability split:
 *   - summarize       → `CursorLlmClient.generate()` (existing SDK path,
 *                       cloud or local-app mode)
 *   - review          → `CursorLlmClient.generate()` with the reviewer
 *                       system prompt baked into the prompt body (the SDK
 *                       has no separate system-prompt slot, so we
 *                       concatenate). Single-turn structured output.
 *   - runConversation → `cursorAgentPrintOnce()` — cursor-agent CLI in
 *                       --print mode, transcript serialized as one
 *                       prompt (same trick `claude -p` uses for
 *                       multi-turn). Per fork #7, path (i).
 *
 * If `cursor-agent` CLI is missing at construction time, the
 * runConversation capability throws `EngineCapabilityUnsupportedError`
 * with a "install cursor-agent or switch engines" hint. summarize / review
 * still work because they only need the SDK (which uses Cursor app auth).
 */

import { randomUUID } from 'node:crypto';
import { createCursorLlmClient } from '../../summarizer/cursor-client.js';
import { cursorAgentPrintOnce, type CursorAgentRunOptions } from '../../cli-agent/cursor.js';
import {
  EngineCapabilityUnsupportedError,
  type EngineAdapter,
  type RunConversationInput,
  type RunConversationResult,
  type ReviewInput,
} from '../types.js';
import type { LlmClient } from '../../summarizer/campaign.js';

// CursorAgentRunOptions['exec'] is the promisified-execFile shape used by
// both adapters. Surfacing this alias keeps the dep type local to this
// module (avoids depending on node:util's promisify generics).
type ExecFileAsync = NonNullable<CursorAgentRunOptions['exec']>;

export interface CursorAdapterDeps {
  /** Cursor SDK options (apiKey / model / mode). Mirrors `liveConfig.cursor`. */
  cursor: {
    apiKey?: string;
    model: string;
    mode: 'local' | 'cloud';
  };
  /**
   * Whether `cursor-agent` CLI is on PATH. Set at construction time by
   * `detectCursorCli`. When false, runConversation throws unsupported.
   */
  cursorAgentAvailable: boolean;
  /** helm MCP SSE endpoint for conversational sessions. */
  helmMcpUrl?: string;
  /** Override cursor-agent binary (testing). */
  cursorAgentBin?: string;
  /** Override the spawner (testing). */
  exec?: ExecFileAsync;
}

export function buildCursorAdapter(deps: CursorAdapterDeps): EngineAdapter {
  // CursorLlmClient mirrors the summarizer's LlmClient interface — direct
  // assignment for `summarize`. Reviewer uses the same client with the
  // system prompt prepended (Cursor SDK has no separate system slot).
  const cursorClient = createCursorLlmClient({
    mode: deps.cursor.mode,
    ...(deps.cursor.apiKey ? { apiKey: deps.cursor.apiKey } : {}),
    modelId: deps.cursor.model,
  });

  const summarize: LlmClient = cursorClient;

  return {
    id: 'cursor',
    summarize,
    async review(input: ReviewInput): Promise<string> {
      // Cursor SDK takes a single prompt; fold the reviewer system prompt
      // into the prompt body. Wrap in marker headers so the model treats
      // it as preamble rather than user instructions to be obeyed verbatim.
      const merged = [
        '=== SYSTEM PROMPT ===',
        input.systemPrompt,
        '=== END SYSTEM PROMPT ===',
        '',
        input.userPayload,
      ].join('\n');
      return cursorClient.generate(merged, {
        model: deps.cursor.model,
        maxTokens: 4096,
      });
    },
    async runConversation(input: RunConversationInput): Promise<RunConversationResult> {
      if (!deps.cursorAgentAvailable) {
        throw new EngineCapabilityUnsupportedError(
          'cursor',
          'runConversation',
          'cursor-agent CLI not found on PATH — required for multi-turn agent '
          + 'sessions. Install it (https://www.cursor.com/cli) or switch the '
          + 'default engine to "claude" in helm Settings.',
        );
      }

      // Serialize the transcript the way claude.ts does — labeled prior
      // turns + the final user message as the active prompt. Cursor's CLI
      // doesn't have a special multi-turn input format; this string is
      // what it sees as "the user's question".
      const prompt = serializeTranscriptForCursor(input.messages);

      const opts: CursorAgentRunOptions = {};
      if (input.cwd) opts.cwd = input.cwd;
      const url = input.helmMcpUrl ?? deps.helmMcpUrl;
      if (url) opts.helmMcpUrl = url;
      if (deps.cursorAgentBin) opts.cursorAgentBin = deps.cursorAgentBin;
      if (deps.exec) opts.exec = deps.exec;
      if (input.systemPrompt) opts.systemPrompt = input.systemPrompt;

      const result = await cursorAgentPrintOnce(prompt, opts);
      return {
        text: result.text,
        stderr: result.stderr,
        sessionId: randomUUID(),
      };
    },
  };
}

/** Same shape as `serializeTranscript` in src/cli-agent/claude.ts. */
function serializeTranscriptForCursor(messages: readonly { role: 'user' | 'assistant'; content: string }[]): string {
  if (messages.length === 0) throw new Error('serializeTranscriptForCursor: empty messages');
  const head = messages.slice(0, -1);
  const last = messages[messages.length - 1]!;
  if (last.role !== 'user') throw new Error('serializeTranscriptForCursor: last message must be from user');

  if (head.length === 0) return last.content;
  const labeled = head
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return `${labeled}\n\n---\n\n${last.content}`;
}
