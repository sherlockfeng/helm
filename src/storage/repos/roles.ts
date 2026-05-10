import type Database from 'better-sqlite3';
import type { AgentSession, KnowledgeChunk, Role } from '../types.js';

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

// ── KnowledgeChunk ─────────────────────────────────────────────────────────

export function insertChunk(db: Database.Database, chunk: KnowledgeChunk): void {
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, source_file, chunk_text, embedding, created_at)
    VALUES (@id, @role_id, @source_file, @chunk_text, @embedding, @created_at)
  `).run({
    id: chunk.id, role_id: chunk.roleId, source_file: chunk.sourceFile ?? null,
    chunk_text: chunk.chunkText,
    embedding: chunk.embedding ? Buffer.from(chunk.embedding.buffer) : null,
    created_at: chunk.createdAt,
  });
}

export function getChunksForRole(db: Database.Database, roleId: string): KnowledgeChunk[] {
  return (db.prepare(`SELECT * FROM knowledge_chunks WHERE role_id = ? ORDER BY created_at ASC`).all(roleId) as Record<string, unknown>[])
    .map((row) => ({
      id: String(row['id']),
      roleId: String(row['role_id']),
      sourceFile: row['source_file'] != null ? String(row['source_file']) : undefined,
      chunkText: String(row['chunk_text']),
      embedding: row['embedding'] != null
        ? new Float32Array((row['embedding'] as Buffer).buffer)
        : undefined,
      createdAt: String(row['created_at']),
    }));
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
