/**
 * `retrieval_log` + `retrieval_log_points` repo (PR 2 / migration v20).
 *
 * Audit trail of every retrieve() call so:
 *   - Conversation Detail (§5.2) can show "knowledge in play at turn N"
 *   - KnowledgePoint Detail (§5.4) can show "conversations citing this point"
 *   - benchmark drift detection (§4.7.5) has data to compute against
 *
 * Two-table split keeps the reverse query (by pointId) on an indexed
 * column instead of scanning a JSON blob. `legContrib` IS still JSON
 * because we only read it back when rendering "why was this hit?"
 * which is a single-row UI lookup, never a filter predicate.
 *
 * Writes are intentionally cheap: a retrieve() call inside the
 * provider should not block on log persistence. Callers that care
 * about log throughput can wrap `recordRetrieval` in setImmediate or
 * a microtask but the table itself is fine for sync writes at the
 * expected scale (a few per chat turn).
 */

import type Database from 'better-sqlite3';
import type { RetrievalLog, RetrievalLogPoint } from '../types.js';

export interface RetrievalLogPointInput {
  pointId: string;
  rank: number;
  fusionScore: number;
  legContrib?: RetrievalLogPoint['legContrib'];
  injected: boolean;
}

/**
 * Insert a retrieve() audit entry as a single transaction so a
 * partial write never leaves an empty header row with no points.
 */
export function recordRetrieval(
  db: Database.Database,
  header: RetrievalLog,
  points: ReadonlyArray<RetrievalLogPointInput>,
): void {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO retrieval_log (id, host_session_id, turn, query_text, ts)
      VALUES (?, ?, ?, ?, ?)
    `).run(header.id, header.hostSessionId, header.turn, header.queryText ?? null, header.ts);

    const insert = db.prepare(`
      INSERT INTO retrieval_log_points
        (log_id, point_id, rank, fusion_score, leg_contrib, injected)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const p of points) {
      insert.run(
        header.id, p.pointId, p.rank, p.fusionScore,
        p.legContrib ? JSON.stringify(p.legContrib) : null,
        p.injected ? 1 : 0,
      );
    }
  })();
}

/**
 * Recent retrievals for a session, newest first. Drives Conversation
 * Detail's right rail. `limit` caps the returned set; specs that walk
 * long histories should paginate by repeated calls with smaller windows.
 */
export function getRetrievalsForSession(
  db: Database.Database,
  hostSessionId: string,
  limit = 50,
): RetrievalLog[] {
  return (db.prepare(`
    SELECT id, host_session_id, turn, query_text, ts
    FROM retrieval_log
    WHERE host_session_id = ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(hostSessionId, limit) as Record<string, unknown>[]).map(rowToLog);
}

/** Points returned by a specific retrieval. Used to expand the "what
 *  did this turn see?" hover panel. */
export function getPointsForRetrieval(
  db: Database.Database,
  logId: string,
): RetrievalLogPoint[] {
  return (db.prepare(`
    SELECT log_id, point_id, rank, fusion_score, leg_contrib, injected
    FROM retrieval_log_points
    WHERE log_id = ?
    ORDER BY rank ASC
  `).all(logId) as Record<string, unknown>[]).map(rowToLogPoint);
}

/**
 * Reverse lookup: every retrieval that surfaced a given point. Powers
 * KnowledgePoint Detail's "Used by N conversations" stat. Returns the
 * header rows so callers can hydrate session metadata as needed.
 */
export function getRetrievalsCitingPoint(
  db: Database.Database,
  pointId: string,
  limit = 100,
): RetrievalLog[] {
  return (db.prepare(`
    SELECT rl.id, rl.host_session_id, rl.turn, rl.query_text, rl.ts
    FROM retrieval_log_points rlp
    JOIN retrieval_log rl ON rl.id = rlp.log_id
    WHERE rlp.point_id = ?
    ORDER BY rl.ts DESC
    LIMIT ?
  `).all(pointId, limit) as Record<string, unknown>[]).map(rowToLog);
}

function rowToLog(r: Record<string, unknown>): RetrievalLog {
  return {
    id: String(r['id']),
    hostSessionId: String(r['host_session_id']),
    turn: Number(r['turn']),
    queryText: r['query_text'] != null ? String(r['query_text']) : undefined,
    ts: Number(r['ts']),
  };
}

function rowToLogPoint(r: Record<string, unknown>): RetrievalLogPoint {
  return {
    logId: String(r['log_id']),
    pointId: String(r['point_id']),
    rank: Number(r['rank']),
    fusionScore: Number(r['fusion_score']),
    legContrib: r['leg_contrib'] != null
      ? safeParseLegContrib(String(r['leg_contrib']))
      : undefined,
    injected: Boolean(r['injected']),
  };
}

function safeParseLegContrib(raw: string): RetrievalLogPoint['legContrib'] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed != null) {
      return parsed as RetrievalLogPoint['legContrib'];
    }
  } catch { /* fall through */ }
  return undefined;
}
