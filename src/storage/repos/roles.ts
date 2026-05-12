import type Database from 'better-sqlite3';
import type {
  AgentSession,
  KnowledgeChunk,
  KnowledgeChunkKind,
  KnowledgeSource,
  KnowledgeSourceKind,
  Role,
} from '../types.js';

function rowToRole(row: Record<string, unknown>): Role {
  return {
    id: String(row['id']),
    name: String(row['name']),
    systemPrompt: String(row['system_prompt']),
    docPath: row['doc_path'] != null ? String(row['doc_path']) : undefined,
    isBuiltin: Boolean(row['is_builtin']),
    createdAt: String(row['created_at']),
  };
}

function rowToAgentSession(row: Record<string, unknown>): AgentSession {
  return {
    provider: String(row['provider']),
    roleId: String(row['role_id']),
    sessionId: String(row['session_id']),
    externalId: String(row['external_id']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

// ── Role ───────────────────────────────────────────────────────────────────

export function upsertRole(db: Database.Database, r: Role): void {
  db.prepare(`
    INSERT INTO roles (id, name, system_prompt, doc_path, is_builtin, created_at)
    VALUES (@id, @name, @system_prompt, @doc_path, @is_builtin, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      system_prompt = excluded.system_prompt,
      doc_path = excluded.doc_path
  `).run({
    id: r.id, name: r.name, system_prompt: r.systemPrompt,
    doc_path: r.docPath ?? null, is_builtin: r.isBuiltin ? 1 : 0, created_at: r.createdAt,
  });
}

export function getRole(db: Database.Database, id: string): Role | undefined {
  const row = db.prepare(`SELECT * FROM roles WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRole(row) : undefined;
}

export function listRoles(db: Database.Database): Role[] {
  return (db.prepare(`SELECT * FROM roles ORDER BY is_builtin DESC, name ASC`).all() as Record<string, unknown>[]).map(rowToRole);
}

export function deleteRole(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM roles WHERE id = ?`).run(id);
}

// ── KnowledgeSource (Phase 73) ─────────────────────────────────────────────

function rowToSource(row: Record<string, unknown>): KnowledgeSource {
  const s: KnowledgeSource = {
    id: String(row['id']),
    roleId: String(row['role_id']),
    kind: String(row['kind']) as KnowledgeSourceKind,
    origin: String(row['origin']),
    fingerprint: String(row['fingerprint']),
    createdAt: String(row['created_at']),
  };
  if (row['label'] != null) s.label = String(row['label']);
  return s;
}

export function insertSource(db: Database.Database, src: KnowledgeSource): void {
  db.prepare(`
    INSERT INTO knowledge_sources (id, role_id, kind, origin, fingerprint, label, created_at)
    VALUES (@id, @role_id, @kind, @origin, @fingerprint, @label, @created_at)
  `).run({
    id: src.id, role_id: src.roleId, kind: src.kind,
    origin: src.origin, fingerprint: src.fingerprint,
    label: src.label ?? null, created_at: src.createdAt,
  });
}

export function getSource(db: Database.Database, id: string): KnowledgeSource | undefined {
  const row = db.prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToSource(row) : undefined;
}

/**
 * Phase 73: lookup by (roleId, fingerprint) so trainRole / updateRole can
 * reuse the same source row when the user re-ingests an identical doc.
 * Returns undefined when no match — caller then inserts a new row.
 */
export function getSourceByFingerprint(
  db: Database.Database,
  roleId: string,
  fingerprint: string,
): KnowledgeSource | undefined {
  const row = db.prepare(
    `SELECT * FROM knowledge_sources WHERE role_id = ? AND fingerprint = ? LIMIT 1`,
  ).get(roleId, fingerprint) as Record<string, unknown> | undefined;
  return row ? rowToSource(row) : undefined;
}

export interface KnowledgeSourceWithStats extends KnowledgeSource {
  chunkCount: number;
}

export function listSourcesForRole(
  db: Database.Database,
  roleId: string,
): KnowledgeSourceWithStats[] {
  const rows = db.prepare(`
    SELECT s.*, (
      SELECT COUNT(*) FROM knowledge_chunks c WHERE c.source_id = s.id
    ) AS chunk_count
    FROM knowledge_sources s
    WHERE s.role_id = ?
    ORDER BY s.created_at ASC
  `).all(roleId) as Array<Record<string, unknown> & { chunk_count: number }>;
  return rows.map((row) => ({
    ...rowToSource(row),
    chunkCount: Number(row['chunk_count']),
  }));
}

/**
 * Phase 73: cascade-delete a source. The schema-level ON DELETE CASCADE
 * on knowledge_chunks.source_id wipes derived chunks atomically. Returns
 * a small summary so callers can confirm the blast radius.
 */
export function deleteSource(
  db: Database.Database,
  id: string,
): { removed: boolean; chunksDeleted: number } {
  const chunksRow = db.prepare(
    `SELECT COUNT(*) AS n FROM knowledge_chunks WHERE source_id = ?`,
  ).get(id) as { n: number };
  const info = db.prepare(`DELETE FROM knowledge_sources WHERE id = ?`).run(id);
  return { removed: info.changes > 0, chunksDeleted: Number(chunksRow.n) };
}

// ── KnowledgeChunk ─────────────────────────────────────────────────────────

export function insertChunk(db: Database.Database, chunk: KnowledgeChunk): void {
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, source_file, chunk_text, embedding, kind, source_id, created_at)
    VALUES (@id, @role_id, @source_file, @chunk_text, @embedding, @kind, @source_id, @created_at)
  `).run({
    id: chunk.id, role_id: chunk.roleId, source_file: chunk.sourceFile ?? null,
    chunk_text: chunk.chunkText,
    embedding: chunk.embedding ? Buffer.from(chunk.embedding.buffer) : null,
    kind: chunk.kind ?? 'other',
    source_id: chunk.sourceId ?? null,
    created_at: chunk.createdAt,
  });
}

export interface GetChunksOptions {
  /** Phase 73: when provided, only chunks with this kind are returned. */
  kind?: KnowledgeChunkKind;
  /** Phase 73: when provided, only chunks for this source row. */
  sourceId?: string;
}

export function getChunksForRole(
  db: Database.Database,
  roleId: string,
  opts: GetChunksOptions = {},
): KnowledgeChunk[] {
  const whereClauses = ['role_id = ?'];
  const params: unknown[] = [roleId];
  if (opts.kind) {
    whereClauses.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.sourceId) {
    whereClauses.push('source_id = ?');
    params.push(opts.sourceId);
  }
  const sql = `SELECT * FROM knowledge_chunks WHERE ${whereClauses.join(' AND ')} ORDER BY created_at ASC`;
  return (db.prepare(sql).all(...params) as Record<string, unknown>[])
    .map((row) => {
      const chunk: KnowledgeChunk = {
        id: String(row['id']),
        roleId: String(row['role_id']),
        chunkText: String(row['chunk_text']),
        kind: (row['kind'] != null ? String(row['kind']) : 'other') as KnowledgeChunkKind,
        createdAt: String(row['created_at']),
      };
      if (row['source_file'] != null) chunk.sourceFile = String(row['source_file']);
      if (row['source_id'] != null) chunk.sourceId = String(row['source_id']);
      if (row['embedding'] != null) {
        chunk.embedding = new Float32Array((row['embedding'] as Buffer).buffer);
      }
      return chunk;
    });
}

export function deleteChunksForRole(db: Database.Database, roleId: string): void {
  db.prepare(`DELETE FROM knowledge_chunks WHERE role_id = ?`).run(roleId);
}

/**
 * Phase 66: delete a single chunk by id. Used by `delete_role_chunk` MCP
 * tool when the user resolves an `update_role` conflict by saying "drop
 * the old version and use the new one" — caller deletes the existing
 * chunk, then re-calls update_role with `force: true`.
 *
 * Returns true when a row was actually removed (so callers can distinguish
 * "deleted" from "id not found, nothing to do").
 */
export function deleteChunkById(db: Database.Database, chunkId: string): boolean {
  const info = db.prepare(`DELETE FROM knowledge_chunks WHERE id = ?`).run(chunkId);
  return info.changes > 0;
}

// ── AgentSession ───────────────────────────────────────────────────────────

export function upsertAgentSession(db: Database.Database, session: AgentSession): void {
  db.prepare(`
    INSERT INTO agent_sessions (provider, role_id, session_id, external_id, created_at, updated_at)
    VALUES (@provider, @role_id, @session_id, @external_id, @created_at, @updated_at)
    ON CONFLICT(provider, role_id, session_id) DO UPDATE SET
      external_id = excluded.external_id,
      updated_at  = excluded.updated_at
  `).run({
    provider: session.provider, role_id: session.roleId, session_id: session.sessionId,
    external_id: session.externalId, created_at: session.createdAt, updated_at: session.updatedAt,
  });
}

export function getAgentSession(
  db: Database.Database,
  provider: string,
  roleId: string,
  sessionId: string,
): AgentSession | undefined {
  const row = db.prepare(
    `SELECT * FROM agent_sessions WHERE provider = ? AND role_id = ? AND session_id = ?`,
  ).get(provider, roleId, sessionId) as Record<string, unknown> | undefined;
  return row ? rowToAgentSession(row) : undefined;
}

export function deleteAgentSessionsForRole(db: Database.Database, roleId: string): void {
  db.prepare(`DELETE FROM agent_sessions WHERE role_id = ?`).run(roleId);
}
