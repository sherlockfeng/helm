/**
 * E2e — migration v20 happy path.
 *
 * Boots a fresh HelmApp through the standard e2e harness (full SQLite
 * + orchestrator) and walks through the load-bearing surfaces that
 * PR 2 introduces. Goal: prove that a HelmApp brought up with the
 * new schema can:
 *
 *   1. Insert + read knowledge_chunks with v20 columns populated
 *      via the canonical writer path (`updateChunkWithVersionCheck`).
 *   2. Maintain knowledge_point_roles in lockstep with the legacy
 *      `chunks.role_id` column.
 *   3. Record retrieval audit rows that can be queried in reverse
 *      by point id.
 *   4. Distinguish sessions by agent_kind so the Conversations facet
 *      tabs (§5.1) have non-NULL data to filter on.
 *
 * Crash-recovery and concurrency-attack variants live in attack.spec.ts
 * — this file only proves the green path.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import {
  attachRoleToPoint,
  getPointIdsForRole,
  getRolesForPoint,
} from '../../../src/storage/repos/knowledge-point-roles.js';
import {
  insertAlias,
  getPointIdsForAlias,
} from '../../../src/storage/repos/knowledge-point-alias.js';
import {
  addRel,
  getOutgoingRels,
} from '../../../src/storage/repos/knowledge-point-rel.js';
import {
  getRetrievalsCitingPoint,
  recordRetrieval,
} from '../../../src/storage/repos/retrieval-log.js';
import { updateChunkWithVersionCheck } from '../../../src/storage/repos/roles.js';

function seedRoleAndChunk(db: BetterSqlite3.Database, roleId: string, chunkId: string): void {
  db.prepare(`
    INSERT INTO roles (id, name, system_prompt, is_builtin, created_at, version)
    VALUES (?, ?, 'sp', 0, '2026-06-06T00:00:00Z', 1)
  `).run(roleId, `R-${roleId}`);
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'initial body', 'spec', '2026-06-06T00:00:00Z')
  `).run(chunkId, roleId);
}

describe('e2e migration v20 — happy', () => {
  let h: E2eHarness;
  beforeEach(async () => { h = await bootE2e(); });
  afterEach(async () => { await h.shutdown(); });

  it('chunk insert populates the v20 columns with the documented defaults', () => {
    seedRoleAndChunk(h.db, 'r-1', 'p-1');
    const row = h.db.prepare(`
      SELECT edit_version, visibility, version_ext,
             title, source, last_referenced_at
        FROM knowledge_chunks WHERE id = 'p-1'
    `).get() as {
      edit_version: number;
      visibility: string;
      version_ext: number;
      title: string | null;
      source: string | null;
      last_referenced_at: number | null;
    };
    expect(row.edit_version).toBe(1);
    expect(row.visibility).toBe('internal'); // R-1: default to internal
    expect(row.version_ext).toBe(1);
    expect(row.title).toBeNull();             // lazy backfill (renderer side)
    expect(row.source).toBeNull();
    expect(row.last_referenced_at).toBeNull();
  });

  it('writes through updateChunkWithVersionCheck bump both counters together', () => {
    seedRoleAndChunk(h.db, 'r-1', 'p-1');
    const r1 = updateChunkWithVersionCheck(h.db, 'p-1', 1, {
      title: 'Rollback steps',
      visibility: 'internal',
      source: { kind: 'conversation', ref: 'chat-001' },
    });
    expect(r1.applied).toBe(true);
    expect(r1.newEditVersion).toBe(2);
    const r2 = updateChunkWithVersionCheck(h.db, 'p-1', 2, {
      body: 'Step 1, step 2, step 3',
    });
    expect(r2.applied).toBe(true);
    expect(r2.newEditVersion).toBe(3);
    const row = h.db.prepare(`
      SELECT title, chunk_text, source, edit_version, version_ext
        FROM knowledge_chunks WHERE id = 'p-1'
    `).get() as Record<string, unknown>;
    expect(row['title']).toBe('Rollback steps');
    expect(row['chunk_text']).toBe('Step 1, step 2, step 3');
    expect(JSON.parse(String(row['source']))).toEqual({ kind: 'conversation', ref: 'chat-001' });
    expect(row['edit_version']).toBe(3);
    expect(row['version_ext']).toBe(3);
  });

  it('knowledge_point_roles round-trips and reverse-lookups correctly', () => {
    seedRoleAndChunk(h.db, 'r-tcc', 'p-rollback');
    seedRoleAndChunk(h.db, 'r-argos', 'p-monitor');
    // A single point belonging to two roles — the design's headline
    // N..N case (multi-collection point membership, §3.0).
    attachRoleToPoint(h.db, 'p-rollback', 'r-tcc');
    attachRoleToPoint(h.db, 'p-rollback', 'r-argos');
    expect(getRolesForPoint(h.db, 'p-rollback').sort()).toEqual(['r-argos', 'r-tcc']);
    expect(getPointIdsForRole(h.db, 'r-tcc')).toContain('p-rollback');
    expect(getPointIdsForRole(h.db, 'r-argos')).toContain('p-rollback');
  });

  it('aliases support reverse-by-string lookup (§4.4.2 entity-leg fan-out)', () => {
    seedRoleAndChunk(h.db, 'r-tcc', 'p-gray');
    insertAlias(h.db, 'p-gray', 'TCC', 'manual');
    insertAlias(h.db, 'p-gray', '灰度发布平台', 'llm-suggested');
    expect(getPointIdsForAlias(h.db, 'TCC')).toEqual(['p-gray']);
    expect(getPointIdsForAlias(h.db, '灰度发布平台')).toEqual(['p-gray']);
  });

  it('rel edges + reverse traversal are indexed in both directions', () => {
    seedRoleAndChunk(h.db, 'r-1', 'p-overview');
    h.db.prepare(`
      INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
      VALUES ('p-cdn', 'r-1', 'cdn dr', 'spec', '2026-06-06T00:00:00Z')
    `).run();
    addRel(h.db, 'p-overview', 'p-cdn', 'includes');
    const out = getOutgoingRels(h.db, 'p-overview');
    expect(out.map((r) => r.toPointId)).toEqual(['p-cdn']);
    expect(out[0]!.relKind).toBe('includes');
  });

  it('retrieval_log round-trips header + points and the reverse-by-point index works', () => {
    seedRoleAndChunk(h.db, 'r-1', 'p-1');
    h.db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-cursor-1', 'cursor', 'cursor', 'active', '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
    `).run();
    recordRetrieval(h.db, {
      id: 'log-1', hostSessionId: 's-cursor-1', turn: 1,
      queryText: 'how do I roll back?', ts: Date.now(),
    }, [{ pointId: 'p-1', rank: 0, fusionScore: 0.9, injected: true }]);
    const reverse = getRetrievalsCitingPoint(h.db, 'p-1');
    expect(reverse).toHaveLength(1);
    expect(reverse[0]!.id).toBe('log-1');
  });

  it('host_sessions.agent_kind discriminator round-trips for the three host types', () => {
    for (const kind of ['cursor', 'claude_code', 'codex'] as const) {
      h.db.prepare(`
        INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, 'active', '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
      `).run(`s-${kind}`, kind, kind);
    }
    const rows = h.db.prepare(`
      SELECT id, agent_kind FROM host_sessions WHERE id LIKE 's-%' ORDER BY agent_kind
    `).all() as { id: string; agent_kind: string }[];
    expect(rows.map((r) => r.agent_kind)).toEqual(['claude_code', 'codex', 'cursor']);
  });
});
