/**
 * `knowledge_point_rel` repo (PR 2 / migration v20).
 *
 * Typed edges between knowledge points. §4.4.2 walks one hop after RRF
 * fusion using these so a query hitting "灰度回滚" also surfaces points
 * marked `includes`-related (e.g. the "灰度部署 step-by-step" runbook).
 *
 * The relations are directional: if A `includes` B, the from/to columns
 * carry A and B respectively. `correspondsTo` is conceptually symmetric
 * but stored once with a consistent ordering (callers choose); the
 * retrieval expansion walks both `from→to` and `to→from` for that
 * kind. `supersedes` flags deprecation chains used by the conflict UI.
 */

import type Database from 'better-sqlite3';
import type { KnowledgePointRel, KnowledgePointRelKind } from '../types.js';

export function addRel(
  db: Database.Database,
  fromPointId: string,
  toPointId: string,
  relKind: KnowledgePointRelKind,
  createdAt: number = Date.now(),
): void {
  if (fromPointId === toPointId) {
    throw new Error(`knowledge_point_rel: self-edges are not allowed (id=${fromPointId})`);
  }
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_point_rel
      (from_point_id, to_point_id, rel_kind, created_at)
    VALUES (?, ?, ?, ?)
  `).run(fromPointId, toPointId, relKind, createdAt);
}

export function removeRel(
  db: Database.Database,
  fromPointId: string,
  toPointId: string,
  relKind: KnowledgePointRelKind,
): void {
  db.prepare(`
    DELETE FROM knowledge_point_rel
      WHERE from_point_id = ? AND to_point_id = ? AND rel_kind = ?
  `).run(fromPointId, toPointId, relKind);
}

/** All outgoing edges from a point, optionally filtered by kind. */
export function getOutgoingRels(
  db: Database.Database,
  fromPointId: string,
  relKind?: KnowledgePointRelKind,
): KnowledgePointRel[] {
  const rows = relKind
    ? db.prepare(`
        SELECT from_point_id, to_point_id, rel_kind, created_at
        FROM knowledge_point_rel
        WHERE from_point_id = ? AND rel_kind = ?
        ORDER BY created_at ASC
      `).all(fromPointId, relKind)
    : db.prepare(`
        SELECT from_point_id, to_point_id, rel_kind, created_at
        FROM knowledge_point_rel
        WHERE from_point_id = ?
        ORDER BY created_at ASC
      `).all(fromPointId);
  return (rows as Record<string, unknown>[]).map((r) => ({
    fromPointId: String(r['from_point_id']),
    toPointId: String(r['to_point_id']),
    relKind: String(r['rel_kind']) as KnowledgePointRelKind,
    createdAt: Number(r['created_at']),
  }));
}

/** All incoming edges to a point, optionally filtered. Used by the
 *  KnowledgePoint Detail "referenced by" panel + cosine-overlap rerank. */
export function getIncomingRels(
  db: Database.Database,
  toPointId: string,
  relKind?: KnowledgePointRelKind,
): KnowledgePointRel[] {
  const rows = relKind
    ? db.prepare(`
        SELECT from_point_id, to_point_id, rel_kind, created_at
        FROM knowledge_point_rel
        WHERE to_point_id = ? AND rel_kind = ?
        ORDER BY created_at ASC
      `).all(toPointId, relKind)
    : db.prepare(`
        SELECT from_point_id, to_point_id, rel_kind, created_at
        FROM knowledge_point_rel
        WHERE to_point_id = ?
        ORDER BY created_at ASC
      `).all(toPointId);
  return (rows as Record<string, unknown>[]).map((r) => ({
    fromPointId: String(r['from_point_id']),
    toPointId: String(r['to_point_id']),
    relKind: String(r['rel_kind']) as KnowledgePointRelKind,
    createdAt: Number(r['created_at']),
  }));
}
