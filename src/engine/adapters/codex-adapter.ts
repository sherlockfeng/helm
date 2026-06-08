/**
 * `buildCodexAdapter()` — EngineAdapter for OpenAI Codex CLI.
 *
 * Mirror of claude-adapter.ts:
 *   - summarize → codexExecOnce() with strict-JSON system prompt
 *   - review    → codexExecOnce() with the reviewer system prompt
 *   - runConversation → CodexCliAgent (stateful per-modal)
 *
 * Stateless per-call: the adapter spawns a fresh `codex exec` per
 * summarize / review invocation, which matches the "Settings save =
 * next call uses new config" hot-reload contract. The trainer
 * conversation path uses CodexCliAgent which holds an --output-last-
 * message tmpdir across turns within a single modal lifetime.
 *
 * The same safety stance applies as in CodexCliAgent: sandbox
 * read-only + approval never + ignore-user-config + skip-git-repo-
 * check. helm controls the subprocess; codex shouldn't be making
 * filesystem mutations or escalating to the user for anything we
 * spawn.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LlmClient } from '../../summarizer/campaign.js';
import { CodexCliAgent, type CodexSpawner } from '../../cli-agent/codex.js';
import type { EngineAdapter, ReviewInput, RunConversationInput, RunConversationResult } from '../types.js';

const DEFAULT_HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Adapter-local spawner — same closed-stdin semantics as CodexCliAgent. */
const defaultExecOnceSpawner: CodexSpawner = (bin, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = options?.timeout && options.timeout > 0
      ? setTimeout(() => child.kill('SIGTERM'), options.timeout)
      : null;
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`codex exec exited with ${signal ? `signal ${signal}` : `code ${code}`}\n${stderr}`);
      Object.assign(err, { code, signal, stdout, stderr });
      reject(err);
    });
  });

export interface CodexAdapterDeps {
  /** helm MCP SSE endpoint injected into the codex subprocess via `-c`. */
  helmMcpUrl?: string;
  /** Override `codex` binary path (testing + Engines › Codex › Binary path). */
  codexBin?: string;
  /** Default model for summarize / review (Engines › Codex › Default model). */
  model?: string;
  /** Trainer-specific model override (Engines › Codex › Trainer model). */
  trainerModel?: string;
  /** Override the spawner (testing). */
  exec?: CodexSpawner;
}

export function buildCodexAdapter(deps: CodexAdapterDeps = {}): EngineAdapter {
  const codexBin = deps.codexBin ?? 'codex';
  const exec = deps.exec ?? defaultExecOnceSpawner;
  const helmMcpUrl = deps.helmMcpUrl ?? DEFAULT_HELM_MCP_URL;

  const summarize: LlmClient = {
    async generate(prompt, options) {
      return codexExecOnce({
        prompt,
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        codexBin, exec, helmMcpUrl,
        ...(deps.model ? { model: deps.model } : {}),
      });
    },
  };

  return {
    id: 'codex',
    summarize,
    async review(input: ReviewInput): Promise<string> {
      return codexExecOnce({
        prompt: input.userPayload,
        systemPrompt: input.systemPrompt,
        cwd: input.cwd,
        helmMcpUrl,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        codexBin, exec,
        ...(deps.model ? { model: deps.model } : {}),
      });
    },
    async runConversation(input: RunConversationInput): Promise<RunConversationResult> {
      const agentOpts: ConstructorParameters<typeof CodexCliAgent>[0] = {
        codexBin,
        ...(deps.exec ? { exec: deps.exec } : {}),
        // Trainer pipeline picks the trainer model when set; falls
        // back to the default model; falls back to codex's own
        // config when neither is set.
        ...(deps.trainerModel ? { model: deps.trainerModel } : deps.model ? { model: deps.model } : {}),
      };
      if (input.cwd) agentOpts.cwd = input.cwd;
      if (input.helmMcpUrl ?? helmMcpUrl) agentOpts.helmMcpUrl = input.helmMcpUrl ?? helmMcpUrl;
      const agent = new CodexCliAgent(agentOpts);
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
 * One-shot `codex exec` invocation. Used by summarize + review where
 * the caller wants a clean string response and doesn't need
 * conversation state.
 */
interface CodexExecOnceInput {
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  helmMcpUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  model?: string;
  codexBin: string;
  exec: CodexSpawner;
}

export async function codexExecOnce(input: CodexExecOnceInput): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'helm-codex-exec-'));
  const lastMessageFile = join(dir, `last-${randomUUID()}.txt`);
  const helmMcpUrl = input.helmMcpUrl ?? DEFAULT_HELM_MCP_URL;
  try {
    const args = [
      'exec',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '-s', 'read-only',
      // No -a/--ask-for-approval here — codex exec is non-interactive
      // so the top-level interactive flag doesn't apply. Sandbox flag
      // above provides the write/shell protection.
      '-o', lastMessageFile,
      '-c', `mcp_servers.helm.url="${helmMcpUrl}"`,
    ];
    if (input.cwd) args.push('-C', input.cwd);
    if (input.model) args.push('-m', input.model);
    // Codex doesn't have a separate --system flag; prepend the system
    // prompt as labeled text so the model treats it as instructions.
    const finalPrompt = input.systemPrompt
      ? `[System]\n${input.systemPrompt}\n\n---\n\n${input.prompt}`
      : input.prompt;
    // Pass prompt as the trailing positional. The default spawner
    // closes stdin (`stdio: ['ignore', ...]`) so codex doesn't sit
    // in its "Reading additional input from stdin" wait state.
    args.push(finalPrompt);

    await input.exec(input.codexBin, args, {
      cwd: input.cwd ?? process.cwd(),
      timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: process.env,
    });
    try { return readFileSync(lastMessageFile, 'utf8').trim(); }
    catch { return ''; }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
