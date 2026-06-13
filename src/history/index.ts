/**
 * History backfill entry point.
 *
 * scanHistory(db, host) parses the requested host's on-disk transcripts and
 * backfills them into helm (idempotent). 'all' runs every parser. The result
 * is one BackfillResult per host scanned, for the UI to summarize.
 */

import type Database from 'better-sqlite3';
import { backfillSessions } from './backfill.js';
import { scanClaudeCodeHistory } from './claude-code.js';
import { scanCodexHistory } from './codex.js';
import { scanCursorHistory } from './cursor.js';
import type { BackfillResult, HistoryHost, ParsedHistorySession } from './types.js';

export type ScanHost = HistoryHost | 'all';

const SCANNERS: Record<HistoryHost, () => ParsedHistorySession[]> = {
  'claude-code': scanClaudeCodeHistory,
  cursor: scanCursorHistory,
  codex: scanCodexHistory,
};

export function scanHistory(db: Database.Database, host: ScanHost): BackfillResult[] {
  const hosts: HistoryHost[] = host === 'all'
    ? ['claude-code', 'cursor', 'codex']
    : [host];
  const results: BackfillResult[] = [];
  for (const h of hosts) {
    let sessions: ParsedHistorySession[];
    try { sessions = SCANNERS[h](); }
    catch { sessions = []; }
    results.push(backfillSessions(db, h, sessions));
  }
  return results;
}

export type { BackfillResult } from './types.js';
