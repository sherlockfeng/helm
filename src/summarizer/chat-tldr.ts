/**
 * Chat TL;DR generator — one block at the top of the Conversations
 * detail pane that answers "what is this chat + what was concluded" in
 * two lines. Regenerated on each Stop hook (no throttle yet; can add
 * once we see real cost numbers).
 *
 * Input: a session's turns (already grouped by groupEventsIntoTurns).
 * Output: a 2-line string starting with "Purpose:" / "Progress:". The
 * generator writes it to `host_sessions.summary` via
 * `setHostSessionSummary` and is a no-op (returns null) when the chat
 * has no turns or the LLM call fails.
 *
 * Engine routing is up to the caller — pass any `LlmClient` (the
 * orchestrator passes `engineRouter.current().summarize` to match the
 * existing campaign summarizer pattern).
 */

import type Database from 'better-sqlite3';
import type { LlmClient } from './campaign.js';
import { setHostSessionSummary } from '../storage/repos/host-sessions.js';
import { listHostEvents } from '../storage/repos/host-event-log.js';
import { groupEventsIntoTurns } from '../api/conversation-detail.js';

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Maximum characters of conversation text fed to the LLM. ~16k chars ≈ 4k tokens. */
const MAX_INPUT_CHARS = 16_000;

export interface ChatTldrDeps {
  llm: LlmClient;
  /** Defaults to "claude-sonnet-4-6". Only the cursor adapter actually reads model. */
  model?: string;
  /** Defaults to 500. TL;DR is meant to be ~2 lines; 500 is plenty of headroom. */
  maxTokens?: number;
}

/**
 * Read the chat's turns, build a prompt, call the LLM, and persist the
 * result. Returns the summary text on success, null on any skip or
 * failure (no throw — fire-and-forget callers don't have to wrap in
 * try/catch).
 */
export async function generateChatTldr(
  db: Database.Database,
  hostSessionId: string,
  deps: ChatTldrDeps,
): Promise<string | null> {
  const events = listHostEvents(db, hostSessionId, { limit: 500 });
  const turns = groupEventsIntoTurns(events);
  if (turns.length === 0) return null;

  const transcript = renderTurnsForPrompt(turns);
  const prompt = buildPrompt(transcript);

  let raw: string;
  try {
    raw = await deps.llm.generate(prompt, {
      model: deps.model ?? DEFAULT_MODEL,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  } catch {
    return null;
  }

  const cleaned = sanitizeSummary(raw);
  if (!cleaned) return null;
  setHostSessionSummary(db, hostSessionId, cleaned);
  return cleaned;
}

/**
 * Render the conversation into a compact prompt-friendly transcript.
 * Truncates each individual message + the whole thing to keep the LLM
 * call cheap. Most-recent first inside the truncation budget so a long
 * tail at the front doesn't starve the actual conclusion.
 */
export function renderTurnsForPrompt(
  turns: ReadonlyArray<{
    index: number;
    userPrompt: { text: string };
    assistantResponse?: { text: string };
  }>,
): string {
  const PER_MESSAGE_CAP = 1200;
  const lines: string[] = [];
  // Iterate newest first; emit oldest-first to give the LLM a normal
  // chronological read. We trim from the *front* if we go over budget.
  const oldestFirst = [...turns].sort((a, b) => a.index - b.index);
  for (const t of oldestFirst) {
    lines.push(`USER: ${truncateForPrompt(t.userPrompt.text, PER_MESSAGE_CAP)}`);
    if (t.assistantResponse) {
      lines.push(`AI: ${truncateForPrompt(t.assistantResponse.text, PER_MESSAGE_CAP)}`);
    }
  }
  let text = lines.join('\n\n');
  if (text.length > MAX_INPUT_CHARS) {
    // Drop oldest content first — preserve the conclusion at the tail.
    text = `[…older turns elided…]\n${text.slice(text.length - MAX_INPUT_CHARS)}`;
  }
  return text;
}

function truncateForPrompt(text: string, cap: number): string {
  const t = text.trim();
  if (t.length <= cap) return t;
  return `${t.slice(0, cap)}…[truncated]`;
}

function buildPrompt(transcript: string): string {
  return [
    'You will read a conversation between a developer (USER) and an AI coding agent (AI),',
    'then write a TWO-LINE summary in the same language the developer used.',
    '',
    'Format — emit exactly these two lines, no preamble, no trailing commentary:',
    '  Purpose: <one-line description of what the developer is trying to do>',
    '  Progress: <one-line description of where the conversation ended up>',
    '',
    'Keep each line under 120 characters. Use the developer\'s own language',
    '(if the chat is in Chinese, write "目的:" / "进展:" with Chinese content).',
    '',
    'Conversation:',
    '---',
    transcript,
    '---',
  ].join('\n');
}

/**
 * Strip any model preamble / wrapping and keep only the two label lines.
 * Returns null when neither label is present.
 */
export function sanitizeSummary(raw: string): string | null {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  // Find Purpose / Progress (English or Chinese label).
  const purposeRegex = /^(?:Purpose|目的)\s*[:：]/i;
  const progressRegex = /^(?:Progress|进展|进度)\s*[:：]/i;
  const purposeLine = lines.find((l) => purposeRegex.test(l));
  const progressLine = lines.find((l) => progressRegex.test(l));
  if (!purposeLine && !progressLine) return null;
  const out: string[] = [];
  if (purposeLine) out.push(purposeLine);
  if (progressLine) out.push(progressLine);
  return out.join('\n');
}
