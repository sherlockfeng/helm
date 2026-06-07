/**
 * `knowledge_point_alias` repo (PR 2 / migration v20).
 *
 * Aliases are the "secondary entity terms" that should resolve to a
 * point — e.g. ["TCC", "灰度发布平台"] for the TCC gray-release point.
 * Stored as a normalized table (was JSON-in-TEXT in design rev 1;
 * reviewer flagged that fixed lookup needs an index). §4.4.2's RRF
 * entity leg folds alias matches into entity overlap; the index
 * `idx_alias_lookup` is what makes that cheap.
 *
 * The `source` field records provenance so the UI can show "you added
 * this" vs "the LLM suggested it" vs "imported from a remote repo".
 * Insert is idempotent on (point_id, alias) so the same alias from
 * multiple sources doesn't duplicate; the first writer's source wins.
 */

import type Database from 'better-sqlite3';
import type { KnowledgePointAlias } from '../types.js';

export type AliasSource = KnowledgePointAlias['source'];

export function insertAlias(
  db: Database.Database,
  pointId: string,
  alias: string,
  source: AliasSource = 'manual',
  createdAt: number = Date.now(),
): void {
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_point_alias (point_id, alias, source, created_at)
    VALUES (?, ?, ?, ?)
  `).run(pointId, alias, source, createdAt);
}

export function deleteAlias(
  db: Database.Database,
  pointId: string,
  alias: string,
): void {
  db.prepare(`
    DELETE FROM knowledge_point_alias WHERE point_id = ? AND alias = ?
  `).run(pointId, alias);
}

/** Replace the full alias set for a point. Used by point-detail edit. */
export function setAliasesForPoint(
  db: Database.Database,
  pointId: string,
  aliases: ReadonlyArray<{ alias: string; source?: AliasSource }>,
  now: number = Date.now(),
): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM knowledge_point_alias WHERE point_id = ?`).run(pointId);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO knowledge_point_alias (point_id, alias, source, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const a of aliases) insert.run(pointId, a.alias, a.source ?? 'manual', now);
  })();
}

export function getAliasesForPoint(
  db: Database.Database,
  pointId: string,
): KnowledgePointAlias[] {
  return (db.prepare(`
    SELECT point_id, alias, source, created_at
    FROM knowledge_point_alias WHERE point_id = ?
    ORDER BY created_at ASC
  `).all(pointId) as Record<string, unknown>[]).map((r) => ({
    pointId: String(r['point_id']),
    alias: String(r['alias']),
    source: String(r['source']) as AliasSource,
    createdAt: Number(r['created_at']),
  }));
}

/**
 * Reverse lookup: given an alias string, return all point ids that
 * carry it. Index `idx_alias_lookup` makes this O(log n); §4.4.2's
 * retrieval calls this on every entity leg hit.
 */
export function getPointIdsForAlias(db: Database.Database, alias: string): string[] {
  return (db.prepare(
    `SELECT point_id FROM knowledge_point_alias WHERE alias = ?`,
  ).all(alias) as { point_id: string }[]).map((r) => r.point_id);
}
