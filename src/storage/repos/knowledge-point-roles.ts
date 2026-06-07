/**
 * `knowledge_point_roles` repo (PR 2 / migration v20).
 *
 * N..N join between KnowledgePoint and Role. Old code reads
 * `knowledge_chunks.role_id` (1..1); new code goes through this table so
 * the same point can belong to multiple collections per design §3.0.
 *
 * The migration backfills one row per existing single-role mapping, so
 * existing data continues to work through the new accessors without any
 * caller-side flag. Writers should:
 *
 *   - call `attachRoleToPoint` when promoting a candidate / accepting an
 *     edit that should land in a specific collection
 *   - call `setRolesForPoint` when the user reassigns a point's roles in
 *     bulk (Library bulk edit, §17.7.9)
 *
 * Readers prefer this table over `knowledge_chunks.role_id` so the N..N
 * intent is visible from grep alone.
 */

import type Database from 'better-sqlite3';

export interface KnowledgePointRoleRow {
  pointId: string;
  roleId: string;
}

/** Add a single (point, role) pairing. No-op if it already exists. */
export function attachRoleToPoint(
  db: Database.Database,
  pointId: string,
  roleId: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_point_roles (point_id, role_id)
    VALUES (?, ?)
  `).run(pointId, roleId);
}

/** Remove a single (point, role) pairing. No-op if absent. */
export function detachRoleFromPoint(
  db: Database.Database,
  pointId: string,
  roleId: string,
): void {
  db.prepare(`
    DELETE FROM knowledge_point_roles WHERE point_id = ? AND role_id = ?
  `).run(pointId, roleId);
}

/**
 * Replace the entire set of roles a point belongs to. Used by §17.7
 * bulk "Move to" / "Reassign" flows where the user picks the final set.
 * Done as a transaction so a half-applied set never leaks.
 */
export function setRolesForPoint(
  db: Database.Database,
  pointId: string,
  roleIds: readonly string[],
): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM knowledge_point_roles WHERE point_id = ?`).run(pointId);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO knowledge_point_roles (point_id, role_id) VALUES (?, ?)`,
    );
    for (const roleId of roleIds) insert.run(pointId, roleId);
  })();
}

/** Get all roles a point currently belongs to. */
export function getRolesForPoint(db: Database.Database, pointId: string): string[] {
  return (db.prepare(
    `SELECT role_id FROM knowledge_point_roles WHERE point_id = ? ORDER BY role_id ASC`,
  ).all(pointId) as { role_id: string }[]).map((r) => r.role_id);
}

/** Get all points belonging to a role. Mirrors the legacy
 *  `getChunksForRole` access pattern but through the N..N table. */
export function getPointIdsForRole(db: Database.Database, roleId: string): string[] {
  return (db.prepare(
    `SELECT point_id FROM knowledge_point_roles WHERE role_id = ? ORDER BY point_id ASC`,
  ).all(roleId) as { point_id: string }[]).map((r) => r.point_id);
}
