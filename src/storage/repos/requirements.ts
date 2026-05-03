import type Database from 'better-sqlite3';
import type { CaptureSession, Requirement, RequirementTodo } from '../types.js';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function rowToRequirement(row: Record<string, unknown>): Requirement {
  return {
    id: String(row['id']),
    name: String(row['name']),
    purpose: row['purpose'] != null ? String(row['purpose']) : undefined,
    context: String(row['context']),
    summary: row['summary'] != null ? String(row['summary']) : undefined,
    relatedDocs: parseJson<string[]>(row['related_docs'], []),
    changes: parseJson<string[]>(row['changes'], []),
    tags: parseJson<string[]>(row['tags'], []),
    todos: parseJson<RequirementTodo[]>(row['todos'], []),
    projectPath: row['project_path'] != null ? String(row['project_path']) : undefined,
    status: row['status'] as Requirement['status'],
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

// ── Requirement ────────────────────────────────────────────────────────────

export function insertRequirement(db: Database.Database, r: Requirement): void {
  db.prepare(`
    INSERT INTO requirements (id, name, purpose, context, summary, related_docs, changes, tags, todos, project_path, status, created_at, updated_at)
    VALUES (@id, @name, @purpose, @context, @summary, @related_docs, @changes, @tags, @todos, @project_path, @status, @created_at, @updated_at)
  `).run({
    id: r.id, name: r.name, purpose: r.purpose ?? null, context: r.context,
    summary: r.summary ?? null,
    related_docs: r.relatedDocs ? JSON.stringify(r.relatedDocs) : null,
    changes: r.changes ? JSON.stringify(r.changes) : null,
    tags: r.tags ? JSON.stringify(r.tags) : null,
    todos: r.todos ? JSON.stringify(r.todos) : null,
    project_path: r.projectPath ?? null,
    status: r.status, created_at: r.createdAt, updated_at: r.updatedAt,
  });
}

export function getRequirement(db: Database.Database, id: string): Requirement | undefined {
  const row = db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRequirement(row) : undefined;
}

export function listRequirements(db: Database.Database, query?: string): Requirement[] {
  if (query) {
    const like = `%${query}%`;
    return (db.prepare(
      `SELECT * FROM requirements WHERE name LIKE ? OR summary LIKE ? OR purpose LIKE ? ORDER BY updated_at DESC`,
    ).all(like, like, like) as Record<string, unknown>[]).map(rowToRequirement);
  }
  return (db.prepare(`SELECT * FROM requirements ORDER BY updated_at DESC`).all() as Record<string, unknown>[]).map(rowToRequirement);
}

export function updateRequirement(
  db: Database.Database,
  id: string,
  patch: Partial<Omit<Requirement, 'id' | 'createdAt'>>,
): void {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [new Date().toISOString()];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.purpose !== undefined) { sets.push('purpose = ?'); params.push(patch.purpose); }
  if (patch.context !== undefined) { sets.push('context = ?'); params.push(patch.context); }
  if (patch.summary !== undefined) { sets.push('summary = ?'); params.push(patch.summary); }
  if (patch.relatedDocs !== undefined) { sets.push('related_docs = ?'); params.push(JSON.stringify(patch.relatedDocs)); }
  if (patch.changes !== undefined) { sets.push('changes = ?'); params.push(JSON.stringify(patch.changes)); }
  if (patch.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(patch.tags)); }
  if (patch.todos !== undefined) { sets.push('todos = ?'); params.push(JSON.stringify(patch.todos)); }
  if (patch.projectPath !== undefined) { sets.push('project_path = ?'); params.push(patch.projectPath); }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  params.push(id);
  db.prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteRequirement(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM requirements WHERE id = ?`).run(id);
}

// ── CaptureSession ─────────────────────────────────────────────────────────

export function insertCaptureSession(db: Database.Database, s: CaptureSession): void {
  db.prepare(`
    INSERT INTO capture_sessions (id, requirement_id, phase, answers, draft, created_at, updated_at)
    VALUES (@id, @requirement_id, @phase, @answers, @draft, @created_at, @updated_at)
  `).run({
    id: s.id, requirement_id: s.requirementId ?? null, phase: s.phase,
    answers: JSON.stringify(s.answers),
    draft: s.draft ? JSON.stringify(s.draft) : null,
    created_at: s.createdAt, updated_at: s.updatedAt,
  });
}

export function getCaptureSession(db: Database.Database, id: string): CaptureSession | undefined {
  const row = db.prepare(`SELECT * FROM capture_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row['id']),
    requirementId: row['requirement_id'] != null ? String(row['requirement_id']) : undefined,
    phase: row['phase'] as CaptureSession['phase'],
    answers: parseJson<Record<string, string>>(row['answers'], {}),
    draft: row['draft'] != null ? parseJson<Partial<Requirement>>(row['draft'], {}) : undefined,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export function updateCaptureSession(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<CaptureSession, 'phase' | 'answers' | 'draft' | 'requirementId'>>,
): void {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [new Date().toISOString()];
  if (patch.phase !== undefined) { sets.push('phase = ?'); params.push(patch.phase); }
  if (patch.answers !== undefined) { sets.push('answers = ?'); params.push(JSON.stringify(patch.answers)); }
  if (patch.draft !== undefined) { sets.push('draft = ?'); params.push(JSON.stringify(patch.draft)); }
  if (patch.requirementId !== undefined) { sets.push('requirement_id = ?'); params.push(patch.requirementId); }
  params.push(id);
  db.prepare(`UPDATE capture_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
