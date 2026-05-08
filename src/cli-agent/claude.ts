/**
 * `ClaudeCodeAgent` — drive Claude Code (`claude`) as a per-modal subprocess
 * for the role-trainer chat (Phase 60b).
 *
 * Architecture (replaces Phase 57's direct-API path):
 *   - The user opens "+ Train a new role via chat" in helm's Roles page.
 *   - For each user turn, helm spawns `claude -p` (print mode) with
 *     `--session-id <uuid>` so claude keeps prior turns in its own
 *     on-disk session storage; subsequent turns add `--resume <uuid>` to
 *     pick the conversation back up.
 *   - `--mcp-config <tmpfile> --strict-mcp-config` injects helm's MCP
 *     server (so the agent can call `train_role`, `read_lark_doc` etc.)
 *     WITHOUT polluting the user's global `~/.claude.json`.
 *   - claude's own auth (`claude login`) runs the model — helm stores zero
 *     API keys for this path.
 *
 * Why per-turn spawn instead of long-lived subprocess:
 *   - simpler lifecycle (no pipe-buffer headaches, no idle-timeout to
 *     reason about, no zombie process risk on helm crash)
 *   - claude's `--session-id` already gives us multi-turn continuity for
 *     free
 *   - cold-start latency is real (~500-1500ms) but tolerable; if it
 *     becomes a UX issue we can switch to streaming mode (Phase 60c).
 *
 * Tool calls happen inside the subprocess — claude executes them against
 * helm's MCP server transparently, then includes the result in its
 * assistant text. We don't surface tool calls as structured chips in this
 * version (output-format=text); the user sees the agent's narrative.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

export interface ClaudeAgentOptions {
  /** helm's MCP HTTP/SSE URL injected via `--mcp-config`. Default 17317. */
  helmMcpUrl?: string;
  /**
   * Working directory the spawned claude process runs in. Claude scopes its
   * own session storage to the cwd, so passing the user's project dir means
   * the agent's built-in `read` / `grep` tools see the right code.
   */
  cwd?: string;
  /** Override the `claude` binary path (testing). */
  claudeBin?: string;
  /** Override the spawner (testing). */
  exec?: typeof execFileAsync;
  /** Per-turn timeout. Long enough to absorb a multi-step tool flow. */
  timeoutMs?: number;
  /** When true, do NOT pass `--strict-mcp-config` (still pass `--mcp-config`).
   *  Useful for users with their own global MCP entries they want kept. */
  allowGlobalMcp?: boolean;
}

export interface ClaudeAgentTurnResult {
  /** Assistant text. May contain narrated tool actions like "✓ saved role". */
  text: string;
  /**
   * Whatever stderr the subprocess wrote. Surfaced to the renderer's debug
   * panel — claude warns there about MCP connection issues, etc.
   */
  stderr: string;
  /** The session-id used for this and future turns. Stable across turns. */
  sessionId: string;
}

const DEFAULT_HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — long enough for multi-tool turns

/** Conversation message — same shape across helm's chat surface. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Per-modal agent. Stateless — each `sendConversation()` call spawns a
 * fresh claude subprocess and passes the entire transcript as the prompt
 * arg. Trade-off vs `--session-id`-based continuity:
 *   - + simpler (no map of sessions, no resume vs new branching)
 *   - + survives helm restart cleanly (no leftover session state to find)
 *   - − higher token cost per turn (full transcript re-sent every time)
 * v1 ships the simple path; if the cost / latency becomes painful, swap
 * to streaming stdin in a follow-up.
 *
 * Caller passes the helm MCP URL once at construction; we materialize a
 * tmp MCP-config file claude reads on each spawn. `dispose()` deletes it.
 */
export class ClaudeCodeAgent {
  /** Stable id helm uses to log + correlate; not currently passed to claude. */
  readonly sessionId: string = randomUUID();
  private readonly cwd: string;
  private readonly claudeBin: string;
  private readonly exec: typeof execFileAsync;
  private readonly timeoutMs: number;
  private readonly mcpConfigPath: string;
  private readonly mcpConfigDir: string;
  private readonly allowGlobalMcp: boolean;

  constructor(options: ClaudeAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.claudeBin = options.claudeBin ?? 'claude';
    this.exec = options.exec ?? execFileAsync;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowGlobalMcp = options.allowGlobalMcp ?? false;
    const url = options.helmMcpUrl ?? DEFAULT_HELM_MCP_URL;

    // Tmp MCP config — claude reads JSON from --mcp-config <file>. Format
    // mirrors `claude mcp add-json`'s expected shape: { mcpServers: { ... }}.
    this.mcpConfigDir = mkdtempSync(join(tmpdir(), 'helm-claude-mcp-'));
    this.mcpConfigPath = join(this.mcpConfigDir, 'mcp.json');
    writeFileSync(
      this.mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          helm: { type: 'sse', url },
        },
      }, null, 2),
    );
  }

  /**
   * Send the full conversation (system prompt + all user/assistant turns)
   * to a fresh `claude -p` invocation. Returns the latest assistant text.
   */
  async sendConversation(
    messages: readonly ChatMessage[],
    options: { systemPrompt?: string } = {},
  ): Promise<ClaudeAgentTurnResult> {
    if (messages.length === 0) {
      throw new Error('ClaudeCodeAgent.sendConversation: empty messages');
    }
    const last = messages[messages.length - 1]!;
    if (last.role !== 'user') {
      throw new Error('ClaudeCodeAgent.sendConversation: last message must be from user');
    }

    const args: string[] = [
      '--print',
      '--output-format', 'text',
      '--mcp-config', this.mcpConfigPath,
    ];
    if (!this.allowGlobalMcp) args.push('--strict-mcp-config');
    if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);

    // Encode the full transcript into a single prompt. Claude is reliable
    // at understanding User: / Assistant: framing — same approach the cookbook
    // CodingAgentSession uses internally.
    args.push(serializeTranscript(messages));

    const { stdout, stderr } = await this.exec(this.claudeBin, args, {
      cwd: this.cwd,
      timeout: this.timeoutMs,
      maxBuffer: 16 * 1024 * 1024, // 16 MB — absorbs long agent traces
      // Inherit env so claude finds its own auth / config.
      env: process.env,
    });

    return {
      text: stdout.toString().trim(),
      stderr: stderr.toString(),
      sessionId: this.sessionId,
    };
  }

  /** Delete the tmp MCP-config dir. Idempotent. */
  dispose(): void {
    try { rmSync(this.mcpConfigDir, { recursive: true, force: true }); }
    catch { /* already gone */ }
  }
}

/** Format a conversation as a single text prompt. Exported for tests. */
export function serializeTranscript(messages: readonly ChatMessage[]): string {
  // All turns except the last get framed; the last user message is the
  // "current prompt" and lands at the end without a label so claude treats
  // it as the active question.
  const head = messages.slice(0, -1);
  const last = messages[messages.length - 1]!;
  const prior = head.length > 0
    ? head.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    + '\n\n---\n\n'
    : '';
  return prior + last.content;
}

/**
 * Probe whether `claude` is on PATH. Used by the orchestrator to decide
 * if the role-trainer chat has a backend at all. Returns null when claude
 * is missing OR the version probe fails.
 */
export async function detectClaudeCli(
  options: { claudeBin?: string; exec?: typeof execFileAsync } = {},
): Promise<{ version: string } | null> {
  const bin = options.claudeBin ?? 'claude';
  const exec = options.exec ?? execFileAsync;
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 5000 });
    return { version: stdout.toString().trim() };
  } catch {
    return null;
  }
}
