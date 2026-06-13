/**
 * Backfill parser for Codex history.
 *
 * Codex writes one JSONL rollout file per session under
 * `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` (and archived
 * copies under `~/.codex/archived_sessions/`). Lines are `{timestamp, type,
 * payload}`:
 *   - session_meta   → { id, cwd, ... }            (session header)
 *   - response_item  → { type:'message', role, content:[{type,text}] }
 *   - event_msg / turn_context / function_call*    (ignored)
 *
 * user messages → prompt turns, assistant messages → response turns.
 * developer/system roles and the injected <environment_context> /
 * <permissions> / <user_instructions> wrappers are dropped.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedHistorySession, ParsedHistoryTurn } from './types.js';

const SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');
const ARCHIVED_ROOT = join(homedir(), '.codex', 'archived_sessions');
const FIRST_PROMPT_MAX = 200;

const NOISE_TAGS = /<(environment_context|permissions[^>]*|user_instructions)>[\s\S]*?<\/(environment_context|permissions|user_instructions)>/g;

/** Collect text from a Codex content array (input_text / output_text / text). */
function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object') {
      const t = (part as Record<string, unknown>)['text'];
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

/** Parse a single rollout file into a session (or null if no real turns). */
export function parseCodexRollout(filePath: string, fallbackId: string): ParsedHistorySession | null {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch { return null; }

  let id = fallbackId;
  let cwd: string | undefined;
  let firstPrompt: string | undefined;
  let firstSeenAt: string | undefined;
  let lastSeenAt: string | undefined;
  const turns: ParsedHistoryTurn[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(trimmed) as Record<string, unknown>; }
    catch { continue; }

    const ts = typeof o['timestamp'] === 'string' ? o['timestamp'] : undefined;
    const payload = o['payload'];
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;

    if (o['type'] === 'session_meta') {
      if (typeof p['id'] === 'string') id = p['id'];
      if (typeof p['cwd'] === 'string') cwd = p['cwd'];
      continue;
    }
    if (o['type'] !== 'response_item' || p['type'] !== 'message') continue;
    const role = p['role'];
    if (role !== 'user' && role !== 'assistant') continue;

    let text = textFromContent(p['content']);
    if (!text) continue;
    if (role === 'user') {
      text = text.replace(NOISE_TAGS, '').trim();
      if (!text) continue;
    } else {
      text = text.trim();
      if (!text) continue;
    }

    const createdAt = ts ?? lastSeenAt ?? new Date(0).toISOString();
    turns.push({ kind: role === 'user' ? 'prompt' : 'response', text, createdAt });
    if (!firstSeenAt) firstSeenAt = createdAt;
    lastSeenAt = createdAt;
    if (role === 'user' && !firstPrompt) firstPrompt = text.slice(0, FIRST_PROMPT_MAX);
  }

  // Real exchange only — at least one prompt and one response.
  if (!turns.some((t) => t.kind === 'prompt') || !turns.some((t) => t.kind === 'response')) {
    return null;
  }
  return {
    id,
    host: 'codex',
    ...(cwd ? { cwd } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    firstSeenAt: firstSeenAt ?? turns[0]!.createdAt,
    lastSeenAt: lastSeenAt ?? turns[turns.length - 1]!.createdAt,
    turns,
  };
}

/** Recursively collect rollout-*.jsonl files under a root. */
function collectRollouts(root: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(root); }
  catch { return; }
  for (const name of entries) {
    const full = join(root, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); }
    catch { continue; }
    if (isDir) collectRollouts(full, out);
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(full);
  }
}

/** uuid tail of `rollout-<ts>-<uuid>.jsonl`, else the bare filename. */
function idFromFilename(file: string): string {
  const base = file.replace(/\.jsonl$/, '');
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1]! : base;
}

export function scanCodexHistory(
  roots: string[] = [SESSIONS_ROOT, ARCHIVED_ROOT],
): ParsedHistorySession[] {
  const files: string[] = [];
  for (const r of roots) if (existsSync(r)) collectRollouts(r, files);
  const out: ParsedHistorySession[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const s = parseCodexRollout(f, idFromFilename(f));
    if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s); }
  }
  return out;
}
