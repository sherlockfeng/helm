/**
 * `knowledge_candidates` repo (Phase 78).
 *
 * Tight surface: insert with dedup catch, list by (role × status), flip
 * to terminal status, fetch by id, count pending. The capture pipeline
 * + the HTTP / MCP layers are the only callers; we keep prepared
 * statements per-call to match the rest of the repos in this codebase.
 */

import type Database from 'better-sqlite3';
import type {
  CandidateProvenance,
  CandidateStatus,
  KnowledgeCandidate,
  KnowledgeChunkKind,
} from '../types.js';

function rowToCandidate(row: Record<string, unknown>): KnowledgeCandidate {
  const c: KnowledgeCandidate = {
    id: String(row['id']),
    roleId: String(row['role_id']),
    chunkText: String(row['chunk_text']),
    sourceSegmentIndex: Number(row['source_segment_index']),
    kind: String(row['kind'] ?? 'other') as KnowledgeChunkKind,
    scoreEntity: Number(row['score_entity']),
    scoreCosine: Number(row['score_cosine']),
    textHash: String(row['text_hash']),
    status: String(row['status']) as CandidateStatus,
    createdAt: String(row['created_at']),
    // Phase 79: provenance column. Default 'chat_capture' for legacy /
    // missing values to match the migration default.
    provenance: (String(row['provenance'] ?? 'chat_capture')) as CandidateProvenance,
  };
  if (row['host_session_id'] != null) c.hostSessionId = String(row['host_session_id']);
  if (row['decided_at'] != null) c.decidedAt = String(row['decided_at']);
  return c;
}

/**
 * Insert a candidate, swallowing the partial-unique-index collision as a
 * "skip, already known" signal. Returns true when a row was actually
 * written (caller emits the `knowledge_candidate.created` event), false
 * when the dedup gate kicked in.
 *
 * Any other SQL error (FK violation, schema drift) bubbles — the caller
 * shouldn't pretend those are normal dedup.
 */
export function insertCandidateIfNew(
  db: Database.Database,
  c: KnowledgeCandidate,
): boolean {
  try {
    db.prepare(`
      INSERT INTO knowledge_candidates
        (id, role_id, host_session_id, chunk_text, source_segment_index,
         kind, score_entity, score_cosine, text_hash, status, created_at, decided_at, provenance)
      VALUES
        (@id, @role_id, @host_session_id, @chunk_text, @source_segment_index,
         @kind, @score_entity, @score_cosine, @text_hash, @status, @created_at, @decided_at, @provenance)
    `).run({
      id: c.id,
      role_id: c.roleId,
      host_session_id: c.hostSessionId ?? null,
      chunk_text: c.chunkText,
      source_segment_index: c.sourceSegmentIndex,
      kind: c.kind,
      score_entity: c.scoreEntity,
      score_cosine: c.scoreCosine,
      text_hash: c.textHash,
      status: c.status,
      created_at: c.createdAt,
      decided_at: c.decidedAt ?? null,
      provenance: c.provenance ?? 'chat_capture',
    });
    return true;
  } catch (err) {
    // better-sqlite3 surfaces unique-violation as a SqliteError with code
    // 'SQLITE_CONSTRAINT_UNIQUE'. ONLY that code counts as the dedup gate.
    //
    // Critical: the parent class 'SQLITE_CONSTRAINT' covers FK / CHECK /
    // NOT NULL violations too — swallowing it would mask the "role got
    // deleted between getHostSession and our insert" race (capture is
    // fire-and-forget) as a benign dedup. Re-throw everything except
    // explicit unique-index hits so the orchestrator's per-role loop can
    // distinguish "already known" from "FK broke" in its catch.
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return false;
    }
    throw err;
  }
}

export function getCandidateById(
  db: Database.Database,
  id: string,
): KnowledgeCandidate | undefined {
  const row = db.prepare(
    `SELECT * FROM knowledge_candidates WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : undefined;
}

export interface ListCandidatesOptions {
  /** Filter by status. Default `'pending'` (the Candidates tab default view). */
  status?: CandidateStatus | 'all';
}

export function listCandidatesForRole(
  db: Database.Database,
  roleId: string,
  opts: ListCandidatesOptions = {},
): KnowledgeCandidate[] {
  const status = opts.status ?? 'pending';
  if (status === 'all') {
    return (db.prepare(
      `SELECT * FROM knowledge_candidates WHERE role_id = ? ORDER BY created_at DESC`,
    ).all(roleId) as Record<string, unknown>[]).map(rowToCandidate);
  }
  return (db.prepare(
    `SELECT * FROM knowledge_candidates WHERE role_id = ? AND status = ? ORDER BY created_at DESC`,
  ).all(roleId, status) as Record<string, unknown>[]).map(rowToCandidate);
}

/**
 * Flip a candidate to a terminal status (`accepted` / `rejected` /
 * `expired`). Pending → terminal is the only legal transition; terminal
 * → terminal is rejected to keep audit consistent. Returns true on
 * success, false when:
 *   - the row doesn't exist (unknown id)
 *   - the row is already in a terminal state
 *
 * Callers (`accept` / `reject` API) interpret `false` as "404 / 409"
 * depending on the lookup result.
 */
export function setCandidateStatus(
  db: Database.Database,
  id: string,
  newStatus: Exclude<CandidateStatus, 'pending'>,
  decidedAt: string,
): boolean {
  const info = db.prepare(`
    UPDATE knowledge_candidates
    SET status = ?, decided_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(newStatus, decidedAt, id);
  return info.changes > 0;
}

/**
 * Update the chunk_text + text_hash on a still-pending candidate. Used
 * by the Edit-then-Accept flow before flipping status. The dedup index
 * would reject an update that collides with another pending row — caller
 * catches the throw and surfaces as "this edit collides with another
 * pending candidate, please reject or wait".
 */
export function updateCandidateText(
  db: Database.Database,
  id: string,
  chunkText: string,
  textHash: string,
): boolean {
  const info = db.prepare(`
    UPDATE knowledge_candidates
    SET chunk_text = ?, text_hash = ?
    WHERE id = ? AND status = 'pending'
  `).run(chunkText, textHash, id);
  return info.changes > 0;
}

/**
 * PR 4 (Review inbox): cross-role list of candidates for the global
 * Review surface (§5.3 wireframe). The page wants:
 *   - default pending-only view
 *   - sort by either score (highest entity+cosine first) or recency
 *   - filter by roleId, status, or both
 *   - capped at a sensible page size
 *
 * Ordering is done at the SQL boundary so the renderer doesn't have
 * to load everything into memory just to sort.
 */
export interface ListReviewCandidatesOptions {
  status?: CandidateStatus | 'all';
  roleId?: string;
  sort?: 'score' | 'recent';
  limit?: number;
}

export function listReviewCandidates(
  db: Database.Database,
  opts: ListReviewCandidatesOptions = {},
): KnowledgeCandidate[] {
  const status = opts.status ?? 'pending';
  const sort = opts.sort ?? 'recent';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  // 'score' ordering: higher is better. Combine entity (weighted ×0.4)
  // and cosine (×0.6) into a single sortable expression — same weights
  // §4.4 used to keep retrieval + review aligned.
  const orderClause = sort === 'score'
    ? `ORDER BY (COALESCE(score_entity, 0) * 0.4 + COALESCE(score_cosine, 0) * 0.6) DESC, created_at DESC`
    : `ORDER BY created_at DESC`;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status !== 'all') { where.push(`status = ?`); params.push(status); }
  if (opts.roleId)      { where.push(`role_id = ?`); params.push(opts.roleId); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return (db.prepare(`
    SELECT * FROM knowledge_candidates
    ${whereClause}
    ${orderClause}
    LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[]).map(rowToCandidate);
}

/**
 * PR 4 bulk-reject. Per R-5 + design §17.7.9 we **never** offer bulk
 * accept (every accept requires a fresh human decision), but bulk
 * reject is safe — the user is saying "none of these are knowledge
 * worth keeping". Runs as a single transaction so a half-applied
 * batch never leaks. Returns the count of rows actually flipped.
 */
export function bulkRejectCandidates(
  db: Database.Database,
  candidateIds: readonly string[],
  decidedAt: string,
): number {
  if (candidateIds.length === 0) return 0;
  const stmt = db.prepare(`
    UPDATE knowledge_candidates
    SET status = 'rejected', decided_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  let changed = 0;
  db.transaction(() => {
    for (const id of candidateIds) {
      const info = stmt.run(decidedAt, id);
      changed += info.changes;
    }
  })();
  return changed;
}

/** Count pending candidates for the role badge in the Roles UI. */
export function countPendingCandidatesForRole(
  db: Database.Database,
  roleId: string,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM knowledge_candidates WHERE role_id = ? AND status = 'pending'`,
  ).get(roleId) as { n: number };
  return Number(row.n);
}

/** Bulk pending-count for the Roles list page — one query, all roles. */
export function pendingCountsByRole(
  db: Database.Database,
): Map<string, number> {
  const rows = db.prepare(
    `SELECT role_id, COUNT(*) AS n FROM knowledge_candidates WHERE status = 'pending' GROUP BY role_id`,
  ).all() as Array<{ role_id: string; n: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r.role_id), Number(r.n));
  return out;
}
