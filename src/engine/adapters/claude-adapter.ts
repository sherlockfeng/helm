/**
 * Claude adapter (Phase 68).
 *
 * Wraps the existing `ClaudeCodeAgent` (multi-turn conversational mode) +
 * a new `claudePrintOnce()` helper (single-turn `claude --print` for
 * summarize / review). The adapter doesn't know about helm's MCP URL
 * structure — the orchestrator passes it through `EngineAdapterFactory`.
 *
 * Three capabilities mapped onto the same underlying CLI:
 *   - summarize      → `claudePrintOnce()` with strict-JSON system prompt
 *                      (caller wraps in `parseJsonWithFormatRetry`)
 *   - review         → `claudePrintOnce()` with the reviewer system prompt
 *   - runConversation → `ClaudeCodeAgent.sendConversation()`
 *
 * `interpretClaudeError` already exists from Phase 60b / 67 — we re-throw
 * errors as-is, letting the caller decide whether to interpret. (The
 * `runReview` wrapper and the role-trainer endpoint both interpret on
 * their own, so we don't want to double-translate.)
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ClaudeCodeAgent } from '../../cli-agent/claude.js';
import type {
  EngineAdapter,
  RunConversationInput,
  RunConversationResult,
  ReviewInput,
} from '../types.js';
import type { LlmClient } from '../../summarizer/campaign.js';

const execFileAsync = promisify(execFile);
const DEFAULT_HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClaudeAdapterDeps {
  /** helm MCP SSE endpoint; injected so reviewer / role-trainer can call tools. */
  helmMcpUrl?: string;
  /** Override `claude` binary path (testing). */
  claudeBin?: string;
  /** Override the spawner (testing). */
  exec?: typeof execFileAsync;
}

/**
 * Construct a claude EngineAdapter. The summarize/review/conversation
 * implementations spawn `claude` per call (stateless), which fits the
 * "Settings save = next call uses new config" hot-reload contract.
 */
export function buildClaudeAdapter(deps: ClaudeAdapterDeps = {}): EngineAdapter {
  const claudeBin = deps.claudeBin ?? 'claude';
  const exec = deps.exec ?? execFileAsync;
  const helmMcpUrl = deps.helmMcpUrl ?? DEFAULT_HELM_MCP_URL;

  const summarize: LlmClient = {
    async generate(prompt, options) {
      return claudePrintOnce({
        prompt,
        // The summarizer prompt already includes the "OUTPUT only JSON"
        // instruction in its body; adding it again as system prompt would
        // be redundant. Leaving systemPrompt undefined lets claude obey
        // the user-prompt instructions directly.
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        claudeBin, exec,
      });
    },
  };

  return {
    id: 'claude',
    summarize,
    async review(input: ReviewInput): Promise<string> {
      return claudePrintOnce({
        prompt: input.userPayload,
        systemPrompt: input.systemPrompt,
        cwd: input.cwd,
        helmMcpUrl,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        claudeBin, exec,
      });
    },
    async runConversation(input: RunConversationInput): Promise<RunConversationResult> {
      // Re-use ClaudeCodeAgent — it already handles --mcp-config tmpfile,
      // strict-mcp-config flag, and disposal. One agent per call (stateless
      // contract; cheap because it's just a tmp-dir).
      const agentOpts: ConstructorParameters<typeof ClaudeCodeAgent>[0] = {
        claudeBin,
        // ClaudeCodeAgent uses execFileAsync at the type level, not our
        // possibly-stubbed `exec`. We pass exec only when the test stubs it.
        ...(deps.exec ? { exec: deps.exec } : {}),
      };
      if (input.cwd) agentOpts.cwd = input.cwd;
      if (input.helmMcpUrl ?? helmMcpUrl) agentOpts.helmMcpUrl = input.helmMcpUrl ?? helmMcpUrl;
      const agent = new ClaudeCodeAgent(agentOpts);
      try {
        const turn = await agent.sendConversation(
          input.messages,
          input.systemPrompt ? { systemPrompt: input.systemPrompt } : {},
        );
        return { text: turn.text, stderr: turn.stderr, sessionId: turn.sessionId };
      } finally {
        agent.dispose();
      }
    },
  };
}

/**
 * One-shot `claude --print` invocation with optional system prompt + tmp
 * MCP config. Shared by summarize and review paths.
 *
 * Why a fresh tmpfile per call: the orchestrator might be on different
 * helm-MCP URLs in test vs prod; baking the URL into a long-lived file
 * would force a "rebuild the file on Settings change" loop. Per-call
 * tmpfile keeps the lifecycle local.
 */
interface ClaudePrintOnceInput {
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  helmMcpUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  claudeBin: string;
  exec: typeof execFileAsync;
}

export async function claudePrintOnce(input: ClaudePrintOnceInput): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'helm-claude-print-'));
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        helm: { type: 'sse', url: input.helmMcpUrl ?? DEFAULT_HELM_MCP_URL },
      },
    }, null, 2),
  );

  try {
    const args = [
      '--print',
      '--output-format', 'text',
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
    ];
    if (input.systemPrompt) {
      args.push('--append-system-prompt', input.systemPrompt);
    }
    args.push(input.prompt);

    const result = await input.exec(input.claudeBin, args, {
      cwd: input.cwd ?? process.cwd(),
      timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return result.stdout.toString().trim();
  } finally {
    // sessionId unused for one-shot; rely on a stable randomUUID for log
    // correlation if a caller needs it.
    void randomUUID();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
