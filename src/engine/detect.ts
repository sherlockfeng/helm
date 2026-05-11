/**
 * Engine availability detection (Phase 68).
 *
 * Returns per-engine readiness so:
 *   (a) orchestrator can decide which adapters to register at boot
 *   (b) Settings UI can show "cursor: ready / claude: missing — Run `claude
 *       login`" rows so users don't pick something that won't work
 *
 * The detection commands are intentionally cheap (`--version` probes).
 * They run at orchestrator boot + on each Settings page open. We do NOT
 * detect "authenticated"-ness separately — that would require a live
 * model call which costs a token. Per fork's `fail-on-use` decision,
 * unauthenticated state surfaces when the user actually invokes the
 * feature, with the actionable error from `interpretClaudeError` /
 * `interpretCursorAgentError`.
 *
 * For the Cursor adapter, "ready" means cursor-agent CLI is on PATH —
 * because runConversation depends on it. summarize/review can technically
 * still run via the SDK without cursor-agent, but for MVP we report the
 * adapter as "ready" only when ALL its capabilities can run. Treating it
 * uniformly avoids "partly ready" footguns where a user picks cursor
 * and Run Review works but Role Trainer doesn't.
 */

import { detectClaudeCli } from '../cli-agent/claude.js';
import { detectCursorAgentCli } from '../cli-agent/cursor.js';
import type { EngineHealth, EngineId } from './types.js';

export interface DetectEnginesOptions {
  /** Test seam: substitute fake probes. */
  detectClaude?: typeof detectClaudeCli;
  detectCursor?: typeof detectCursorAgentCli;
}

export async function detectEngines(opts: DetectEnginesOptions = {}): Promise<EngineHealth[]> {
  const detectClaude = opts.detectClaude ?? detectClaudeCli;
  const detectCursor = opts.detectCursor ?? detectCursorAgentCli;

  const [claudeInfo, cursorInfo] = await Promise.all([
    detectClaude().catch(() => null),
    detectCursor().catch(() => null),
  ]);

  const claudeHealth: EngineHealth = claudeInfo
    ? { engine: 'claude', ready: true, detail: claudeInfo.version }
    : {
        engine: 'claude', ready: false,
        detail: 'claude CLI not on PATH',
        hint: 'Install Claude Code from https://code.claude.com, then `claude login` once.',
      };

  const cursorHealth: EngineHealth = cursorInfo
    ? { engine: 'cursor', ready: true, detail: cursorInfo.version }
    : {
        engine: 'cursor', ready: false,
        detail: 'cursor-agent CLI not on PATH',
        hint: 'Install cursor-agent (https://www.cursor.com/cli) and sign in to Cursor.app.',
      };

  return [claudeHealth, cursorHealth];
}

/**
 * Cold-boot helper: per fork #8, when `~/.helm/config.json` doesn't have
 * `engine.default` set, pick a sensible value based on what's installed.
 * Caller is the loader / orchestrator startup path.
 */
export function pickBootDefault(healths: readonly EngineHealth[]): EngineId {
  const ready = healths.filter((h) => h.ready).map((h) => h.engine);
  if (ready.length === 1) return ready[0]!;
  // Both ready OR neither ready → default to claude (existing reviewer /
  // role-trainer path; least surprise for current users).
  return 'claude';
}
