/**
 * `CodexCliAgent` — drive OpenAI Codex CLI (`codex`) as a per-modal
 * subprocess for the role-trainer chat + summarizer + Harness reviewer
 * paths. Mirrors `ClaudeCodeAgent` so the EngineRouter can swap
 * trainers without callers re-shaping their conversation.
 *
 * Codex CLI shape (v0.136+):
 *
 *   codex exec [OPTIONS] [PROMPT]
 *     -m, --model <MODEL>                Model for this invocation
 *     -C, --cd <DIR>                     Working dir for the spawned agent
 *     -s, --sandbox <MODE>               read-only | workspace-write | danger-full-access
 *     -a, --ask-for-approval <POLICY>    untrusted | on-failure | on-request | never
 *     -o, --output-last-message <FILE>   Final agent message → tmpfile (clean extract)
 *     --skip-git-repo-check              Don't refuse to run outside a git tree
 *     --ignore-user-config               Drop ~/.codex/config.toml for this run
 *     --json                             Emit JSONL events on stdout (we ignore)
 *
 * Safety stance for helm-spawned codex subprocesses:
 *   -s read-only          codex won't write to disk or shell out destructively
 *   -a never              never escalate to user approval — fail closed instead
 *   --ignore-user-config  user's local codex config (sandbox tweaks, env policy)
 *                         doesn't bleed into helm's deterministic subprocess
 *   --skip-git-repo-check helm runs codex against arbitrary cwds, not always git
 *
 * Conversation continuity: per-turn full transcript re-sent (stateless),
 * same trade-off as ClaudeCodeAgent — simpler lifecycle, higher token
 * cost. Switch to `codex resume` if cost becomes painful.
 *
 * MCP wiring: codex reads MCP servers from ~/.codex/config.toml — for
 * helm's transient subprocess we use `-c mcp_servers.helm.url=…` so the
 * agent can call helm's tools without us touching the user's config
 * file on every spawn. The MCP entry is installed permanently via
 * `setupMcp('codex')` (separate path — Settings › Engines › Codex
 * "Install hooks" button or boot-time auto-register).
 */

import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './claude.js';

const execFileAsync = promisify(execFile);

/**
 * Spawn wrapper that drives `codex` with closed stdin. We can't use
 * execFile here because passing `input:` keeps stdin open until the
 * write completes, and codex's `exec` subcommand detects the open
 * pipe + waits for additional input even when a positional prompt
 * is given. `stdio: ['ignore', 'pipe', 'pipe']` tells Node to give
 * codex a closed stdin from the start, which avoids the race
 * entirely. Promise resolves on exit 0; rejects on non-zero with
 * the captured streams attached.
 */
async function spawnCodex(
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
      : null;
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(
        `codex exec exited with ${signal ? `signal ${signal}` : `code ${code}`}\n${stderr}`,
      );
      Object.assign(err, { code, signal, stdout, stderr });
      reject(err);
    });
  });
}

const DEFAULT_HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Spawner contract — same shape as `promisify(execFile)` so test
 * stubs that captured the old signature keep working. Production
 * binds this to spawnCodex (which uses node:child_process spawn
 * with stdio: ['ignore', 'pipe', 'pipe']); tests inject a fake
 * that captures argv + returns a synthetic { stdout, stderr }.
 */
export type CodexSpawner = (
  bin: string,
  args: readonly string[],
  options?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface CodexAgentOptions {
  /** helm's MCP HTTP/SSE URL injected via `-c mcp_servers.helm.url`. */
  helmMcpUrl?: string;
  /** Working directory the spawned codex process runs in. */
  cwd?: string;
  /** Override the `codex` binary path (testing + Settings binary-path knob). */
  codexBin?: string;
  /** Override the model (Settings › Engines › Codex › Default model). */
  model?: string;
  /** Override the spawner (testing). */
  exec?: CodexSpawner;
  /** Per-turn timeout. */
  timeoutMs?: number;
}

/** Default spawner — closes stdin so codex doesn't wait for input. */
const defaultSpawner: CodexSpawner = (bin, args, options) =>
  spawnCodex(bin, args, {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
    ...(options?.env ? { env: options.env } : {}),
  });

export interface CodexAgentTurnResult {
  /** Assistant text — pulled from --output-last-message tmpfile. */
  text: string;
  /** stderr the subprocess wrote (auth warnings / MCP connection issues). */
  stderr: string;
  /** Stable id helm uses to correlate; not currently passed to codex. */
  sessionId: string;
}

/**
 * Per-modal codex agent. Stateless across turns — each
 * `sendConversation()` call spawns a fresh `codex exec` subprocess
 * with the entire transcript inlined into the prompt arg.
 */
export class CodexCliAgent {
  readonly sessionId: string = randomUUID();
  private readonly cwd: string;
  private readonly codexBin: string;
  private readonly model: string | undefined;
  private readonly exec: CodexSpawner;
  private readonly timeoutMs: number;
  private readonly helmMcpUrl: string;
  private readonly tmpDir: string;

  constructor(options: CodexAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.codexBin = options.codexBin ?? 'codex';
    if (options.model) this.model = options.model;
    this.exec = options.exec ?? defaultSpawner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.helmMcpUrl = options.helmMcpUrl ?? DEFAULT_HELM_MCP_URL;
    // Holds the --output-last-message file across turns. Cleared on
    // dispose() so we don't leak per-modal tmpdirs.
    this.tmpDir = mkdtempSync(join(tmpdir(), 'helm-codex-'));
  }

  /**
   * Send the full conversation to a fresh `codex exec` invocation.
   * Returns the latest assistant text from --output-last-message.
   */
  async sendConversation(
    messages: readonly ChatMessage[],
    options: { systemPrompt?: string } = {},
  ): Promise<CodexAgentTurnResult> {
    if (messages.length === 0) {
      throw new Error('CodexCliAgent.sendConversation: empty messages');
    }
    const last = messages[messages.length - 1]!;
    if (last.role !== 'user') {
      throw new Error('CodexCliAgent.sendConversation: last message must be from user');
    }
    const lastMessageFile = join(this.tmpDir, `last-${randomUUID()}.txt`);

    const args: string[] = [
      'exec',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '-s', 'read-only',
      // `-a`/`--ask-for-approval` is only on the interactive top-level
      // codex command — `codex exec` is non-interactive by nature so
      // there's nothing to escalate. The sandbox flag above is what
      // actually constrains writes / shell-outs.
      '-o', lastMessageFile,
      // Inject helm's MCP server via -c override so we don't touch the
      // user's ~/.codex/config.toml on every spawn.
      '-c', `mcp_servers.helm.url="${this.helmMcpUrl}"`,
      '-C', this.cwd,
    ];
    if (this.model) args.push('-m', this.model);
    // Pass prompt as the trailing positional. Stdin is explicitly
    // closed via spawnCodex's `stdio: ['ignore', ...]` so codex
    // doesn't sit in its "Reading additional input from stdin"
    // state waiting for an EOF that never came.
    args.push(serializeCodexPrompt(messages, options.systemPrompt));

    const result = await this.exec(this.codexBin, args, {
      cwd: this.cwd,
      timeout: this.timeoutMs,
      env: process.env,
    }).catch((err: NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown }) => {
      // codex exec exits non-zero when the model refuses / sandbox
      // denied a command. The last-message file is usually still
      // written; surface the partial response + stderr so the renderer
      // can show context rather than a bare "failed" toast.
      const stderr = err.stderr ? String(err.stderr) : err.message;
      let text = '';
      try { text = readFileSync(lastMessageFile, 'utf8').trim(); } catch { /* file missing */ }
      throw Object.assign(new Error(stderr), {
        stderr,
        stdout: err.stdout ? String(err.stdout) : '',
        partialText: text,
      });
    });

    let text = '';
    try { text = readFileSync(lastMessageFile, 'utf8').trim(); } catch { /* fall through */ }
    return {
      text,
      stderr: result.stderr.toString(),
      sessionId: this.sessionId,
    };
  }

  /** Drop the tmp dir holding --output-last-message files. */
  dispose(): void {
    try { rmSync(this.tmpDir, { recursive: true, force: true }); }
    catch { /* already gone */ }
  }
}

// ── Error classification ────────────────────────────────────────────

export type CodexErrorHint = 'install' | 'login' | 'unknown';

export interface InterpretedCodexError {
  message: string;
  hint: CodexErrorHint;
  raw: string;
}

const NEEDS_LOGIN_RE = /\b(login required|please log[\s-]?in|sign[\s-]?in|not authenticated|unauthorized|401|api[\s-]?key.*(missing|required|not set))\b/i;
const NOT_INSTALLED_RE = /\bENOENT\b|\bcommand not found\b|\bno such file or directory\b|\bspawn.*ENOENT\b/i;

export function interpretCodexError(err: unknown): InterpretedCodexError {
  const e = err as { message?: string; stderr?: unknown; stdout?: unknown; code?: string };
  const stderr = e.stderr ? String(e.stderr) : '';
  const stdout = e.stdout ? String(e.stdout) : '';
  const rawMessage = e.message ?? String(err);
  const haystack = `${rawMessage}\n${stderr}\n${stdout}`;
  const raw = [rawMessage, stderr.trim()].filter((s) => s.length > 0).join('\n');

  if (e.code === 'ENOENT' || NOT_INSTALLED_RE.test(haystack)) {
    return {
      message:
        'codex CLI not found on PATH. Install Codex from https://github.com/openai/codex '
        + '(or via the OpenAI Codex desktop app), then run `codex login` once and retry.',
      hint: 'install', raw,
    };
  }
  if (NEEDS_LOGIN_RE.test(haystack)) {
    return {
      message:
        'codex CLI is installed but not authenticated. Run `codex login` in a terminal, '
        + "complete the flow, then retry. helm holds zero API keys for this path — codex's "
        + 'own auth runs the model.',
      hint: 'login', raw,
    };
  }
  return { message: rawMessage, hint: 'unknown', raw };
}

/**
 * Serialize the transcript the same way the claude agent does — past
 * turns get role labels, the last user message lands without a label
 * so codex treats it as the active prompt.
 */
export function serializeCodexPrompt(
  messages: readonly ChatMessage[],
  systemPrompt?: string,
): string {
  const head = messages.slice(0, -1);
  const last = messages[messages.length - 1]!;
  const prior = head.length > 0
    ? head.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
      + '\n\n---\n\n'
    : '';
  // codex exec doesn't have a separate --system flag; prepend system
  // prompt as a labeled block so the model treats it as instructions.
  const prefix = systemPrompt ? `[System]\n${systemPrompt}\n\n---\n\n` : '';
  return prefix + prior + last.content;
}

/**
 * Probe whether `codex` is on PATH. Mirrors detectClaudeCli's contract.
 */
export async function detectCodexCli(
  options: { codexBin?: string; exec?: typeof execFileAsync } = {},
): Promise<{ version: string } | null> {
  // `--version` exits quickly with output on stdout — the original
  // execFile contract is fine here (no stdin reading, no `exec`
  // subcommand quirks). We keep this path separate from the agent's
  // spawn helper so probe latency stays minimal.
  const bin = options.codexBin ?? 'codex';
  const exec = options.exec ?? execFileAsync;
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 5000 });
    return { version: stdout.toString().trim() };
  } catch {
    return null;
  }
}
