/**
 * Backfill parser for Cursor history.
 *
 * Cursor keeps chat ("composer") data in a SQLite KV store at
 * `…/Cursor/User/globalStorage/state.vscdb`, table `cursorDiskKV`:
 *   - composerData:<composerId>  → { composerId, name, createdAt,
 *       lastUpdatedAt, fullConversationHeadersOnly: [{bubbleId, type}] }
 *   - bubbleId:<composerId>:<bubbleId> → { type: 1=user|2=assistant, text }
 *
 * We read each composer's ordered headers, pull each bubble, and emit
 * prompt (type 1) / response (type 2) turns. Empty-text bubbles (tool /
 * thinking steps) are skipped. The DB is opened read-only so we never
 * disturb a running Cursor.
 */

import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedHistorySession, ParsedHistoryTurn } from './types.js';

const DEFAULT_DB = join(
  homedir(), 'Library', 'Application Support', 'Cursor',
  'User', 'globalStorage', 'state.vscdb',
);
const FIRST_PROMPT_MAX = 200;

/** Epoch-ms (number or numeric string) → ISO; undefined when unparseable. */
function msToIso(v: unknown): string | undefined {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  try { return new Date(n).toISOString(); } catch { return undefined; }
}

interface Header { bubbleId: string; type: number }

export function scanCursorHistory(
  dbPath: string = DEFAULT_DB,
): ParsedHistorySession[] {
  if (!existsSync(dbPath)) return [];
  let db: BetterSqlite3.Database;
  try { db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return []; }

  const out: ParsedHistorySession[] = [];
  try {
    const bubbleStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const composers = db.prepare(
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
    ).all() as { key: string; value: string }[];

    for (const { value } of composers) {
     try {
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(value) as Record<string, unknown>; }
      catch { continue; }
      // Some composerData rows are the literal `null` or non-objects —
      // guard before property access, and isolate per-composer failures so
      // one bad row can't abort the whole scan (the original bug: a `null`
      // row threw past the JSON try and emptied the entire result).
      if (!meta || typeof meta !== 'object') continue;
      const composerId = typeof meta['composerId'] === 'string' ? meta['composerId'] : null;
      const headers = meta['fullConversationHeadersOnly'];
      if (!composerId || !Array.isArray(headers) || headers.length === 0) continue;

      const createdIso = msToIso(meta['createdAt']);
      const updatedIso = msToIso(meta['lastUpdatedAt']);
      const turns: ParsedHistoryTurn[] = [];
      let firstPrompt: string | undefined;
      const name = typeof meta['name'] === 'string' ? meta['name'].trim() : '';

      for (const h of headers as Header[]) {
        if (!h || typeof h.bubbleId !== 'string') continue;
        const row = bubbleStmt.get(`bubbleId:${composerId}:${h.bubbleId}`) as
          { value: string } | undefined;
        if (!row) continue;
        let bubble: Record<string, unknown>;
        try { bubble = JSON.parse(row.value) as Record<string, unknown>; }
        catch { continue; }
        if (!bubble || typeof bubble !== 'object') continue;
        const text = typeof bubble['text'] === 'string' ? bubble['text'].trim() : '';
        if (!text) continue;
        const kind = bubble['type'] === 1 ? 'prompt' : bubble['type'] === 2 ? 'response' : null;
        if (!kind) continue;
        // Cursor bubbles carry no per-message timestamp; approximate with the
        // composer's created time so ordering stays stable (array order is the
        // real sequence the grouper relies on).
        turns.push({ kind, text, createdAt: createdIso ?? new Date(0).toISOString() });
        if (kind === 'prompt' && !firstPrompt) firstPrompt = text.slice(0, FIRST_PROMPT_MAX);
      }

      // Real exchange only — at least one prompt and one response.
      if (!turns.some((t) => t.kind === 'prompt') || !turns.some((t) => t.kind === 'response')) {
        continue;
      }
      out.push({
        id: composerId,
        host: 'cursor',
        ...(firstPrompt ? { firstPrompt: name || firstPrompt } : (name ? { firstPrompt: name } : {})),
        firstSeenAt: createdIso ?? turns[0]!.createdAt,
        lastSeenAt: updatedIso ?? createdIso ?? turns[turns.length - 1]!.createdAt,
        turns,
      });
     } catch { /* skip one malformed composer, keep scanning */ }
    }
  } finally {
    db.close();
  }
  return out;
}
