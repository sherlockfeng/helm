import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillSessions } from '../../../src/history/backfill.js';
import { getHostSession } from '../../../src/storage/repos/host-sessions.js';
import { listHostEvents } from '../../../src/storage/repos/host-event-log.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { ParsedHistorySession } from '../../../src/history/types.js';

let db: BetterSqlite3.Database;
beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => db.close());

const session: ParsedHistorySession = {
  id: 'h1',
  host: 'claude-code',
  cwd: '/proj',
  firstPrompt: 'q1',
  firstSeenAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-01-01T00:00:02Z',
  turns: [
    { kind: 'prompt', text: 'q1', createdAt: '2026-01-01T00:00:00Z' },
    { kind: 'response', text: 'a1', createdAt: '2026-01-01T00:00:01Z' },
  ],
};

describe('backfillSessions', () => {
  it('inserts a closed session + its turns as host_event_log rows', () => {
    const r = backfillSessions(db, 'claude-code', [session]);
    expect(r).toEqual({ host: 'claude-code', imported: 1, skipped: 0, turns: 2 });
    const row = getHostSession(db, 'h1');
    expect(row?.status).toBe('closed');
    expect(row?.agentKind).toBe('claude_code');
    expect(row?.cwd).toBe('/proj');
    const events = listHostEvents(db, 'h1');
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'response']);
    expect(events[0]!.payload).toEqual({ text: 'q1', cwd: '/proj' });
    expect(events[1]!.payload).toEqual({ text: 'a1' });
  });

  it('is idempotent — re-scanning skips existing sessions, no duplicate events', () => {
    backfillSessions(db, 'claude-code', [session]);
    const second = backfillSessions(db, 'claude-code', [session]);
    expect(second).toEqual({ host: 'claude-code', imported: 0, skipped: 1, turns: 0 });
    expect(listHostEvents(db, 'h1')).toHaveLength(2);
  });
});
