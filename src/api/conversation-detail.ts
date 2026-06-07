/**
 * PR 3 — Conversation Detail aggregator.
 *
 * Joins together the four data shapes the three-pane wireframe (§5.2)
 * needs into a single response. The renderer can paint without
 * additional round-trips and the joins happen against the index columns
 * v20 added so cost stays bounded.
 *
 *   1. Header — host_session row (id / agent_kind / status / cwd /
 *      role bindings / label) so the left rail can title the page.
 *   2. Timeline — host_event_log entries, ordered chronologically.
 *      The renderer slices by `kind` to lay out user / agent turns.
 *   3. Knowledge in play — retrieval_log rows for the session, each
 *      hydrated with its matched point ids (PR 2's normalized
 *      retrieval_log_points table). The renderer pairs them with the
 *      turn timeline by `turn` index.
 *   4. Candidates extracted — knowledge_candidates rows tied to this
 *      session that have status='pending'. Empty when none exist.
 *
 * Bounded reads — every query carries a LIMIT so a runaway log can't
 * spike memory. Callers asking for everything should page.
 */

import type Database from 'better-sqlite3';
import { getHostSession } from '../storage/repos/host-sessions.js';
import { listHostEvents } from '../storage/repos/host-event-log.js';
import {
  getPointsForRetrieval,
  getRetrievalsForSession,
} from '../storage/repos/retrieval-log.js';
import type {
  HostEventLogEntry,
  HostSession,
  RetrievalLog,
  RetrievalLogPoint,
} from '../storage/types.js';

export interface ConversationDetail {
  session: HostSession;
  timeline: HostEventLogEntry[];
  knowledgeInPlay: ReadonlyArray<{
    log: RetrievalLog;
    points: RetrievalLogPoint[];
  }>;
  /**
   * Candidates surfaced from this conversation, still awaiting review.
   * Empty for sessions that produced nothing capture-worthy; the
   * renderer hides the panel entirely when this is empty.
   */
  candidates: ReadonlyArray<{
    id: string;
    chunkText: string;
    scoreEntity?: number;
    scoreCosine?: number;
    createdAt: string;
  }>;
}

export interface ConversationDetailOptions {
  /** Cap on host_event_log rows returned. Default 500 — long enough for a
   *  multi-hour session but short enough to keep the JSON payload small. */
  timelineLimit?: number;
  /** Cap on retrieval_log rows returned. Default 100 — typical chat has
   *  ≤2 retrievals per turn so 100 covers ~50 turns. */
  retrievalLimit?: number;
  /** Cap on candidates returned. Default 20 — Review inbox can paginate
   *  the rest. */
  candidateLimit?: number;
}

const DEFAULT_TIMELINE_LIMIT = 500;
const DEFAULT_RETRIEVAL_LIMIT = 100;
const DEFAULT_CANDIDATE_LIMIT = 20;

/**
 * Build the merged detail for one session. Returns `null` if no session
 * exists with the given id (the API layer maps that to 404).
 */
export function getConversationDetail(
  db: Database.Database,
  hostSessionId: string,
  opts: ConversationDetailOptions = {},
): ConversationDetail | null {
  const session = getHostSession(db, hostSessionId);
  if (!session) return null;

  const timelineLimit = opts.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;
  const retrievalLimit = opts.retrievalLimit ?? DEFAULT_RETRIEVAL_LIMIT;
  const candidateLimit = opts.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;

  const timeline = listHostEvents(db, hostSessionId, { limit: timelineLimit });

  const retrievals = getRetrievalsForSession(db, hostSessionId, retrievalLimit);
  const knowledgeInPlay = retrievals.map((log) => ({
    log,
    points: getPointsForRetrieval(db, log.id),
  }));

  // Candidates: tied to this session via the `host_session_id` FK on
  // knowledge_candidates. Pending only — accepted/rejected are visible
  // in the Review history surface but don't belong on the live detail.
  // Read with a small typed query to avoid pulling a repo-wide helper
  // that doesn't filter by session.
  const candidates = (db.prepare(`
    SELECT id, chunk_text, score_entity, score_cosine, created_at
      FROM knowledge_candidates
     WHERE host_session_id = ? AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT ?
  `).all(hostSessionId, candidateLimit) as Record<string, unknown>[]).map((r) => {
    const out: ConversationDetail['candidates'][number] = {
      id: String(r['id']),
      chunkText: String(r['chunk_text']),
      createdAt: String(r['created_at']),
    };
    if (r['score_entity'] != null) out.scoreEntity = Number(r['score_entity']);
    if (r['score_cosine'] != null) out.scoreCosine = Number(r['score_cosine']);
    return out;
  });

  return { session, timeline, knowledgeInPlay, candidates };
}
