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
import { getRetrievalsForSession } from '../storage/repos/retrieval-log.js';
import { suggestRolesForChat, type RoleSuggestion } from '../knowledge/chat-role-suggester.js';
import type {
  HostEventLogEntry,
  HostSession,
  RetrievalLog,
  RetrievalLogPoint,
} from '../storage/types.js';

/**
 * One retrieved point hydrated with the chunk-side metadata the renderer
 * needs to render `→ title · source · 0.82` rows without N+1 round-trips
 * to /api/knowledge/points/:id. Falls back to placeholders when the chunk
 * was deleted after retrieval (rare — chunks are FK-protected, but the
 * join is left-outer just in case).
 */
export interface KnowledgeInPlayPoint extends RetrievalLogPoint {
  /** chunk.title — short label, or undefined if the chunk no longer exists. */
  title?: string;
  /** chunk.source_file — the path/URL the chunk came from. */
  sourceFile?: string;
  /** chunk.role_id — which role this chunk belongs to. Drives chip color. */
  roleId?: string;
  /** Role display name, joined for renderer convenience. */
  roleName?: string;
}

/**
 * One turn = one user prompt + the assistant response that followed +
 * any tool events (tool_use / tool_result / progress) that fired
 * between this prompt and the next. The renderer's Timeline section
 * walks these instead of the raw event log — turn granularity matches
 * how a developer mentally segments the chat.
 *
 * The response is optional because a turn can be in-flight (prompt sent
 * but response not yet captured) or because some agents emit events
 * helm doesn't yet log as 'response' kind.
 */
export interface ConversationDetailTurn {
  /** 1-indexed turn number within the chat. */
  index: number;
  userPrompt: { text: string; createdAt: string };
  assistantResponse?: { text: string; createdAt: string };
  /** Tool calls / progress events that fell within this turn's window. */
  toolEvents: ReadonlyArray<{
    kind: HostEventLogEntry['kind'];
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface ConversationDetail {
  session: HostSession;
  /** Raw chronological events. Kept for back-compat + power consumers. */
  timeline: HostEventLogEntry[];
  /** Pre-grouped turns. Empty when the chat hasn't logged any prompt yet. */
  turns: ConversationDetailTurn[];
  knowledgeInPlay: ReadonlyArray<{
    log: RetrievalLog;
    points: KnowledgeInPlayPoint[];
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
    /** PR3: one-line LLM headline; renderer prefers this over chunkText. */
    gist?: string;
    /** PR3: classified kind from KnowledgeChunkKind taxonomy. */
    kind?: 'spec' | 'example' | 'warning' | 'runbook' | 'glossary' | 'other';
  }>;
  /**
   * Curation-discovery layer: roles whose entity index overlaps with
   * this chat's text. Drives the "💡 这条对话涉及" suggestion section in
   * the detail pane. Empty when no role's entities show up in the
   * conversation (or when the chat hasn't logged enough text yet).
   */
  roleSuggestions: RoleSuggestion[];
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
  const turns = groupEventsIntoTurns(timeline);

  const retrievals = getRetrievalsForSession(db, hostSessionId, retrievalLimit);
  const knowledgeInPlay = retrievals.map((log) => ({
    log,
    points: hydratePointsForRetrieval(db, log.id),
  }));

  // Candidates: tied to this session via the `host_session_id` FK on
  // knowledge_candidates. Pending only — accepted/rejected are visible
  // in the Review history surface but don't belong on the live detail.
  // Read with a small typed query to avoid pulling a repo-wide helper
  // that doesn't filter by session.
  const candidates = (db.prepare(`
    SELECT id, chunk_text, score_entity, score_cosine, created_at, gist, kind
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
    if (r['gist'] != null) out.gist = String(r['gist']);
    if (r['kind'] != null) {
      out.kind = String(r['kind']) as ConversationDetail['candidates'][number]['kind'];
    }
    return out;
  });

  const roleSuggestions = suggestRolesForChat(db, hostSessionId);

  return { session, timeline, turns, knowledgeInPlay, candidates, roleSuggestions };
}

/**
 * Walk an event log (already in chronological order) and group into
 * turns. A `prompt` starts a new turn; subsequent `response` /
 * `tool_use` / `tool_result` / `progress` events accumulate into the
 * current turn. The last turn may lack a response (in-flight chat).
 *
 * Events before the first prompt (rare — only if an out-of-order
 * response fires before any prompt is captured) are dropped: they
 * don't belong to any turn the renderer can render.
 *
 * Exported for unit testing. The aggregator's purity (no DB / no Date)
 * makes it easy to pin.
 */
export function groupEventsIntoTurns(
  events: readonly HostEventLogEntry[],
): ConversationDetailTurn[] {
  const turns: ConversationDetailTurn[] = [];
  let current: {
    index: number;
    userPrompt: { text: string; createdAt: string };
    assistantResponse?: { text: string; createdAt: string };
    toolEvents: Array<{
      kind: HostEventLogEntry['kind'];
      payload: Record<string, unknown>;
      createdAt: string;
    }>;
  } | null = null;

  for (const ev of events) {
    if (ev.kind === 'prompt') {
      if (current) turns.push(current);
      const text = typeof ev.payload['text'] === 'string'
        ? (ev.payload['text'] as string)
        : '';
      current = {
        index: turns.length + 1,
        userPrompt: { text, createdAt: ev.createdAt },
        toolEvents: [],
      };
      continue;
    }
    if (!current) continue; // orphan event before first prompt

    if (ev.kind === 'response') {
      const text = typeof ev.payload['text'] === 'string'
        ? (ev.payload['text'] as string)
        : '';
      // Last response in the turn wins — long agent responses can emit
      // multiple chunks. The renderer wants the final concatenated text.
      current.assistantResponse = { text, createdAt: ev.createdAt };
      continue;
    }
    current.toolEvents.push({
      kind: ev.kind,
      payload: ev.payload,
      createdAt: ev.createdAt,
    });
  }
  if (current) turns.push(current);
  return turns;
}

/**
 * Hydrate retrieval points with chunk + role metadata in one query. Used
 * instead of `getPointsForRetrieval` (raw points only) so the renderer
 * gets `title · source · roleName` without an N+1 fetch per point. The
 * join is LEFT OUTER on chunks because a chunk may have been deleted
 * after this retrieval landed.
 */
function hydratePointsForRetrieval(
  db: Database.Database,
  logId: string,
): KnowledgeInPlayPoint[] {
  const rows = db.prepare(`
    SELECT
      rlp.log_id, rlp.point_id, rlp.rank, rlp.fusion_score,
      rlp.leg_contrib, rlp.injected,
      kc.title       AS chunk_title,
      kc.source_file AS chunk_source_file,
      kc.role_id     AS chunk_role_id,
      r.name         AS role_name
    FROM retrieval_log_points rlp
    LEFT JOIN knowledge_chunks kc ON kc.id = rlp.point_id
    LEFT JOIN roles            r  ON r.id  = kc.role_id
    WHERE rlp.log_id = ?
    ORDER BY rlp.rank ASC
  `).all(logId) as Record<string, unknown>[];

  return rows.map((r) => {
    const base: KnowledgeInPlayPoint = {
      logId: String(r['log_id']),
      pointId: String(r['point_id']),
      rank: Number(r['rank']),
      fusionScore: Number(r['fusion_score']),
      injected: Number(r['injected']) === 1,
    };
    if (r['leg_contrib']) {
      try { base.legContrib = JSON.parse(String(r['leg_contrib'])); }
      catch { /* malformed historic blob — drop the field */ }
    }
    if (r['chunk_title']) base.title = String(r['chunk_title']);
    if (r['chunk_source_file']) base.sourceFile = String(r['chunk_source_file']);
    if (r['chunk_role_id']) base.roleId = String(r['chunk_role_id']);
    if (r['role_name']) base.roleName = String(r['role_name']);
    return base;
  });
}
