/**
 * `cursor-agent` CLI wrapper (Phase 68).
 *
 * Cursor's CLI ships as `cursor-agent` (separate from the `cursor` app
 * binary). It supports a `--print` / `-p` non-interactive mode that mirrors
 * `claude -p`'s shape — single-shot run from a prompt, JSON or text output,
 * MCP server can be wired via config flags.
 *
 * helm uses this from the cursor EngineAdapter to deliver the same three
 * capabilities the claude adapter does:
 *   - summarize / review : `cursor-agent --print` with system prompt
 *   - runConversation    : serialize the transcript as a single prompt and
 *                          let cursor-agent handle the agentic loop
 *
 * If `cursor-agent` isn't on PATH (only Cursor app installed, no CLI), the
 * adapter falls back to throwing `EngineCapabilityUnsupportedError`. The
 * upstream `EngineRouter.current()` then surfaces the friendly "switch
 * engine in Settings" message — same shape claude-not-installed produces.
 *
 * Per fork #7: path (i) — cursor-agent CLI as the conversational backend.
 * Path (ii) — Cursor SDK with manual tool-use loop — is a follow-up if
 * cursor-agent's coverage on user machines turns out lower than expected.
 *
 * Implementation note: the `cursor-agent` CLI is younger than `claude` and
 * its flag names move between versions. We accept that here by keeping the
 * arg list explicit + well-commented; if Cursor renames `--print` we have
 * one place to patch.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface CursorAgentRunOptions {
  /** Working directory; the agent's read/grep tools scope to this. */
  cwd?: string;
  /** helm MCP SSE URL — injected via `--mcp-config`. */
  helmMcpUrl?: string;
  /** Override binary path (testing / non-default install). */
  cursorAgentBin?: string;
  /** Override the spawner (testing). */
  exec?: typeof execFileAsync;
  /** Per-call timeout. */
  timeoutMs?: number;
  /** Optional system prompt appended to the run. */
  systemPrompt?: string;
}

export interface CursorAgentRunResult {
  text: string;
  stderr: string;
}

/**
 * One-shot `cursor-agent` invocation. Mirrors `claudePrintOnce()` in
 * shape so the two adapters can share semantic guarantees (timeout
 * behavior, stderr surfacing, tmp MCP config cleanup).
 */
export async function cursorAgentPrintOnce(
  prompt: string,
  options: CursorAgentRunOptions = {},
): Promise<CursorAgentRunResult> {
  const bin = options.cursorAgentBin ?? 'cursor-agent';
  const exec = options.exec ?? execFileAsync;

  const dir = mkdtempSync(join(tmpdir(), 'helm-cursor-agent-'));
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        helm: { type: 'sse', url: options.helmMcpUrl ?? DEFAULT_HELM_MCP_URL },
      },
    }, null, 2),
  );

  try {
    // Flag set chosen to mirror `claude --print` semantics:
    //   --print               non-interactive
    //   --output-format text  plain stdout
    //   --mcp-config <file>   inject helm's MCP
    // cursor-agent's actual flag names may need adjustment per version;
    // we expose `exec` override so a future patch can substitute a wrapper
    // that translates flags without touching the adapter.
    const args = [
      '--print',
      '--output-format', 'text',
      '--mcp-config', mcpConfig,
    ];
    if (options.systemPrompt) {
      // cursor-agent equivalent of claude's --append-system-prompt. If the
      // real flag differs, this is the patch point.
      args.push('--append-system-prompt', options.systemPrompt);
    }
    args.push(prompt);

    const result = await exec(bin, args, {
      cwd: options.cwd ?? process.cwd(),
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return {
      text: result.stdout.toString().trim(),
      stderr: result.stderr.toString(),
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

/**
 * `cursor-agent --version` probe. Returns a stable string when the CLI is
 * on PATH, null otherwise. Used by `detectCursorCli` in engine/detect.ts.
 */
export async function detectCursorAgentCli(
  options: { cursorAgentBin?: string; exec?: typeof execFileAsync } = {},
): Promise<{ version: string } | null> {
  const bin = options.cursorAgentBin ?? 'cursor-agent';
  const exec = options.exec ?? execFileAsync;
  try {
    const r = await exec(bin, ['--version'], { timeout: 5000 });
    const version = (r.stdout.toString() + r.stderr.toString()).trim().split('\n')[0] ?? '';
    return { version };
  } catch {
    return null;
  }
}

/**
 * Same shape as `interpretClaudeError` but for `cursor-agent`. CLI is
 * newer + less common — most failures will be ENOENT. We still keep the
 * shape symmetric so the UI can render either engine's hints identically.
 */
export type CursorErrorHint = 'install' | 'login' | 'unknown';

export interface InterpretedCursorError {
  message: string;
  hint: CursorErrorHint;
  raw: string;
}

const CURSOR_NOT_INSTALLED_RE = /\bENOENT\b|\bcommand not found\b|\bno such file or directory\b|\bspawn.*ENOENT\b/i;
const CURSOR_NEEDS_LOGIN_RE = /\b(login|sign[\s-]?in|unauthorized|not authenticated|invalid api key|401)\b/i;

export function interpretCursorAgentError(err: unknown): InterpretedCursorError {
  const e = err as { message?: string; stderr?: unknown; stdout?: unknown; code?: string };
  const stderr = e.stderr ? String(e.stderr) : '';
  const stdout = e.stdout ? String(e.stdout) : '';
  const rawMessage = e.message ?? String(err);
  const haystack = `${rawMessage}\n${stderr}\n${stdout}`;
  const raw = [rawMessage, stderr.trim()].filter((s) => s.length > 0).join('\n');

  if (e.code === 'ENOENT' || CURSOR_NOT_INSTALLED_RE.test(haystack)) {
    return {
      message:
        'cursor-agent CLI not found on PATH. Install it (`brew install cursor-agent` '
        + 'on macOS, or download from https://www.cursor.com/cli), sign in to Cursor, '
        + 'then retry. Alternatively, switch the default engine to "claude" in '
        + 'helm Settings if you have Claude Code instead.',
      hint: 'install',
      raw,
    };
  }
  if (CURSOR_NEEDS_LOGIN_RE.test(haystack)) {
    return {
      message:
        'cursor-agent is installed but not authenticated. Open Cursor.app and sign '
        + 'in (or `cursor-agent login` from your terminal), then retry. '
        + "helm holds zero API keys for this path — Cursor's own auth runs the model.",
      hint: 'login',
      raw,
    };
  }
  return { message: rawMessage, hint: 'unknown', raw };
}
