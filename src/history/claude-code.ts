/**
 * Backfill parser for Claude Code history.
 *
 * Claude Code writes one JSONL file per session at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, one event per line.
 * We walk every project dir, parse each transcript into ordered
 * prompt/response turns, and return one ParsedHistorySession per file.
 *
 * Turn extraction (kept deliberately close to what the live capture stores):
 *   - prompt   = a `type:'user'` line carrying real user text. Lines that are
 *                meta (isMeta), sidechain sub-agent traffic (isSidechain), or
 *                pure tool_result payloads (no text block) are skipped.
 *   - response = a `type:'assistant'` line's concatenated text blocks.
 *                thinking / tool_use blocks contribute nothing, so an
 *                assistant line that only thought or called a tool is skipped.
 *
 * tool_use / tool_result / progress and the many bookkeeping line types
 * (custom-title, bridge-session, file-history-snapshot, …) are ignored.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedHistorySession, ParsedHistoryTurn } from './types.js';

const DEFAULT_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const FIRST_PROMPT_MAX = 200;

/** Concatenate the text blocks of a message content (string or block array). */
function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') { parts.push(part); continue; }
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (p['type'] === 'text' && typeof p['text'] === 'string') parts.push(p['text']);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

/** Drop helm/CLI-injected system-reminder wrappers; returns '' if nothing left. */
function stripSystemNoise(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

interface ParsedClaudeFile {
  session: ParsedHistorySession | null;
}

/** Parse a single transcript file into a ParsedHistorySession (or null if empty). */
export function parseClaudeTranscript(filePath: string, sessionId: string): ParsedClaudeFile {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch { return { session: null }; }

  const turns: ParsedHistoryTurn[] = [];
  let cwd: string | undefined;
  let firstPrompt: string | undefined;
  let firstSeenAt: string | undefined;
  let lastSeenAt: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(trimmed) as Record<string, unknown>; }
    catch { continue; }

    const type = o['type'];
    if (type !== 'user' && type !== 'assistant') continue;
    if (o['isMeta'] === true || o['isSidechain'] === true) continue;

    if (typeof o['cwd'] === 'string' && !cwd) cwd = o['cwd'];
    const ts = typeof o['timestamp'] === 'string' ? o['timestamp'] : undefined;

    const message = o['message'];
    const content = message && typeof message === 'object'
      ? (message as Record<string, unknown>)['content']
      : o['content'];
    let text = textFromContent(content);
    if (!text) continue;

    if (type === 'user') {
      text = stripSystemNoise(text);
      if (!text) continue;
    } else {
      text = text.trim();
      if (!text) continue;
    }

    const createdAt = ts ?? lastSeenAt ?? new Date(0).toISOString();
    turns.push({ kind: type === 'user' ? 'prompt' : 'response', text, createdAt });
    if (!firstSeenAt) firstSeenAt = createdAt;
    lastSeenAt = createdAt;
    if (type === 'user' && !firstPrompt) {
      firstPrompt = text.slice(0, FIRST_PROMPT_MAX);
    }
  }

  // Only import real exchanges — a session needs at least one user prompt
  // AND one assistant response. Drops title-gen / summarizer / single-blip
  // sidechains that would otherwise flood the History list.
  if (!turns.some((t) => t.kind === 'prompt') || !turns.some((t) => t.kind === 'response')) {
    return { session: null };
  }
  return {
    session: {
      id: sessionId,
      host: 'claude-code',
      ...(cwd ? { cwd } : {}),
      ...(firstPrompt ? { firstPrompt } : {}),
      firstSeenAt: firstSeenAt ?? turns[0]!.createdAt,
      lastSeenAt: lastSeenAt ?? turns[turns.length - 1]!.createdAt,
      turns,
    },
  };
}

/**
 * Scan all Claude Code project dirs and return one ParsedHistorySession per
 * non-empty transcript. Best-effort: unreadable dirs/files are skipped.
 */
export function scanClaudeCodeHistory(
  projectsRoot: string = DEFAULT_PROJECTS_ROOT,
): ParsedHistorySession[] {
  if (!existsSync(projectsRoot)) return [];
  let dirs: string[];
  try { dirs = readdirSync(projectsRoot); }
  catch { return []; }

  const out: ParsedHistorySession[] = [];
  for (const dir of dirs) {
    const dirPath = join(projectsRoot, dir);
    let files: string[];
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      files = readdirSync(dirPath);
    } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      const { session } = parseClaudeTranscript(join(dirPath, file), sessionId);
      if (session) out.push(session);
    }
  }
  return out;
}
