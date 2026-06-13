/**
 * Idempotent backfill writer.
 *
 * Turns ParsedHistorySession objects (from the per-host parsers) into the same
 * host_sessions (status='closed') + host_event_log rows the live bridge path
 * writes. Sessions whose id already exists in the DB are skipped wholesale —
 * so re-scanning never duplicates events, and a backfilled session that later
 * goes live just continues appending under the same id.
 */

import type Database from 'better-sqlite3';
import type { AgentKind } from '../storage/types.js';
import { appendHostEvent } from '../storage/repos/host-event-log.js';
import { getHostSession, upsertHostSession } from '../storage/repos/host-sessions.js';
import type { BackfillResult, HistoryHost, ParsedHistorySession } from './types.js';

function hostToAgentKind(host: HistoryHost): AgentKind {
  switch (host) {
    case 'claude-code': return 'claude_code';
    case 'cursor': return 'cursor';
    case 'codex': return 'codex';
  }
}

/**
 * Insert the given sessions, skipping any whose id already exists. Runs in a
 * single transaction. `host` labels the returned result (all sessions in one
 * call share a host).
 */
export function backfillSessions(
  db: Database.Database,
  host: HistoryHost,
  sessions: readonly ParsedHistorySession[],
): BackfillResult {
  let imported = 0;
  let skipped = 0;
  let turns = 0;

  const run = db.transaction((list: readonly ParsedHistorySession[]) => {
    for (const s of list) {
      if (getHostSession(db, s.id)) { skipped++; continue; }
      upsertHostSession(db, {
        id: s.id,
        host: s.host,
        agentKind: hostToAgentKind(s.host),
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.firstPrompt ? { firstPrompt: s.firstPrompt } : {}),
        status: 'closed',
        firstSeenAt: s.firstSeenAt,
        lastSeenAt: s.lastSeenAt,
      });
      for (const t of s.turns) {
        appendHostEvent(db, {
          hostSessionId: s.id,
          kind: t.kind,
          payload: t.kind === 'prompt' && s.cwd
            ? { text: t.text, cwd: s.cwd }
            : { text: t.text },
          createdAt: t.createdAt,
        });
        turns++;
      }
      imported++;
    }
  });
  run(sessions);

  return { host, imported, skipped, turns };
}
