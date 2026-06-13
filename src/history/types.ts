/**
 * Backfill of pre-helm conversations.
 *
 * helm normally only sees conversations that arrive live through the bridge
 * hooks. Sessions that happened before helm was installed (or while it wasn't
 * running) never produce hook events, so they're invisible. The backfill
 * reads each host's on-disk transcript history, synthesizes the same
 * host_sessions (status='closed') + host_event_log rows the live path would
 * have written, and the entire read/extract/summarize path then works on them
 * unchanged.
 *
 * Each host parser returns a list of ParsedHistorySession; backfill.ts turns
 * those into DB rows idempotently (sessions already in the DB are skipped, so
 * re-scanning is safe and never duplicates events).
 */

/** Host id string as stored in host_sessions.host (hyphenated). */
export type HistoryHost = 'claude-code' | 'cursor' | 'codex';

/** One reconstructed turn — maps 1:1 to a host_event_log row. */
export interface ParsedHistoryTurn {
  kind: 'prompt' | 'response';
  text: string;
  /** ISO timestamp; ordering within a session is by this then array order. */
  createdAt: string;
}

/** One reconstructed session — maps to a host_sessions row + its turns. */
export interface ParsedHistorySession {
  id: string;
  host: HistoryHost;
  cwd?: string;
  firstPrompt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  turns: ParsedHistoryTurn[];
}

/** Per-host scan result, surfaced to the user after a scan. */
export interface BackfillResult {
  host: string;
  /** Sessions newly inserted. */
  imported: number;
  /** Sessions skipped because they already exist in the DB. */
  skipped: number;
  /** Total turns (host_event_log rows) inserted across imported sessions. */
  turns: number;
}
