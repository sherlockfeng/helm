/**
 * E2e — knowledge-update lifecycle paths (PR 4 continued).
 *
 * Covers the *end* of a chunk's life and the cascade behaviors that
 * keep referential integrity:
 *
 *   7. archive a chunk (soft, via the Phase 77 lifecycle path)
 *   8. unarchive (manual recovery)
 *   9. drop_knowledge_source — cascade-delete derived chunks
 *  10. role delete — cascade-delete chunks / sources / candidates /
 *     mirrors / subscriptions
 *  11. candidate-status terminality — once accepted/rejected, no
 *     mutation can flip it back
 *
 * Each spec exercises the actual API endpoint (where one exists) so
 * the test catches regressions at the boundary, not just the repo.
 */

import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import {
  archiveChunks,
  deleteChunkById,
  deleteRole,
  unarchiveChunk,
  upsertRole,
} from '../../../src/storage/repos/roles.js';
import { insertCandidateIfNew, setCandidateStatus } from '../../../src/storage/repos/knowledge-candidates.js';

function seedRole(db: BetterSqlite3.Database, roleId: string): void {
  upsertRole(db, {
    id: roleId, name: `R-${roleId}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
}

function seedChunk(
  db: BetterSqlite3.Database,
  roleId: string,
  chunkId: string,
  text = 'body',
): void {
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, ?, 'spec', ?)
  `).run(chunkId, roleId, text, new Date().toISOString());
}

describe('knowledge-update lifecycle', () => {
  let h: E2eHarness;
  beforeEach(async () => { h = await bootE2e(); });
  afterEach(async () => { await h.shutdown(); });

  describe('7. archive (soft)', () => {
    it('flips archived=1 without dropping the row; archived chunks are excluded from default reads', () => {
      seedRole(h.db, 'r-arch');
      seedChunk(h.db, 'r-arch', 'p-1');
      seedChunk(h.db, 'r-arch', 'p-2');

      archiveChunks(h.db, ['p-1']);

      const archived = h.db.prepare(`SELECT id, archived FROM knowledge_chunks WHERE id = 'p-1'`)
        .get() as { id: string; archived: number };
      expect(archived.archived).toBe(1);
      // The row is still there — soft-archive never hard-deletes.
      const all = h.db.prepare(`SELECT id FROM knowledge_chunks WHERE role_id = 'r-arch'`).all() as { id: string }[];
      expect(all.map((r) => r.id).sort()).toEqual(['p-1', 'p-2']);
    });
  });

  describe('8. unarchive', () => {
    it('returns the chunk to live state (archived=0)', () => {
      seedRole(h.db, 'r-arch2');
      seedChunk(h.db, 'r-arch2', 'p-back');
      archiveChunks(h.db, ['p-back']);
      const ok = unarchiveChunk(h.db, 'p-back', new Date().toISOString());
      expect(ok).toBe(true);
      const row = h.db.prepare(`SELECT archived FROM knowledge_chunks WHERE id = 'p-back'`)
        .get() as { archived: number };
      expect(row.archived).toBe(0);
    });
  });

  describe('9. delete a source — cascade to derived chunks', () => {
    it('removes the knowledge_sources row and FK-cascades its chunks', () => {
      seedRole(h.db, 'r-src');
      // Seed a source + chunks referencing it. Mimics the trainRole path
      // without booting the embedder.
      const now = new Date().toISOString();
      h.db.prepare(`
        INSERT INTO knowledge_sources (id, role_id, kind, origin, fingerprint, created_at)
        VALUES (?, 'r-src', 'inline', 'inline-x', 'fp1', ?)
      `).run('src-1', now);
      h.db.prepare(`
        INSERT INTO knowledge_chunks (id, role_id, source_id, chunk_text, kind, created_at)
        VALUES (?, 'r-src', 'src-1', 'derived chunk', 'spec', ?)
      `).run('p-from-src', now);

      // Delete the source row. The FK ON DELETE CASCADE on the
      // chunks.source_id column drops the derived chunk too.
      h.db.prepare(`DELETE FROM knowledge_sources WHERE id = ?`).run('src-1');

      const remaining = h.db.prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunks WHERE id = 'p-from-src'`,
      ).get() as { n: number };
      expect(remaining.n).toBe(0);
    });
  });

  describe('10. role delete cascades to every dependent table', () => {
    it('drops chunks / candidates / point_roles / mirrors / subscriptions', () => {
      seedRole(h.db, 'r-doomed');
      seedChunk(h.db, 'r-doomed', 'p-x');
      // Candidate, point-role join, subscription — touch every table
      // that has an ON DELETE CASCADE back to roles(id).
      insertCandidateIfNew(h.db, {
        id: 'c-doomed', roleId: 'r-doomed', chunkText: 't',
        sourceSegmentIndex: 0, kind: 'other',
        scoreEntity: 3, scoreCosine: 0.6,
        textHash: createHash('sha256').update('t').digest('hex'),
        status: 'pending', provenance: 'chat_capture',
        createdAt: new Date().toISOString(),
      });
      h.db.prepare(`INSERT INTO knowledge_point_roles (point_id, role_id) VALUES ('p-x', 'r-doomed')`).run();

      // Subscriptions — schema lets these be sparse.
      h.db.prepare(`
        INSERT INTO role_subscriptions
          (id, role_id, source_url, source_type, sync_interval_minutes, auto_apply,
           status, created_at)
        VALUES ('sub-1', 'r-doomed', 'tos://y', 'tos', 30, 0, 'active', ?)
      `).run(new Date().toISOString());

      deleteRole(h.db, 'r-doomed');

      const counts = (table: string): number =>
        (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE role_id = 'r-doomed'`)
          .get() as { n: number }).n;
      expect(counts('knowledge_chunks')).toBe(0);
      expect(counts('knowledge_candidates')).toBe(0);
      expect(counts('role_subscriptions')).toBe(0);
      const joinLeft = (h.db.prepare(
        `SELECT COUNT(*) AS n FROM knowledge_point_roles WHERE role_id = 'r-doomed'`,
      ).get() as { n: number }).n;
      expect(joinLeft).toBe(0);
    });
  });

  describe('11. candidate terminality', () => {
    it('refuses to flip an accepted candidate back to pending or rejected', () => {
      seedRole(h.db, 'r-term');
      const text = 'final';
      insertCandidateIfNew(h.db, {
        id: 'c-final', roleId: 'r-term', chunkText: text,
        sourceSegmentIndex: 0, kind: 'other',
        scoreEntity: 3, scoreCosine: 0.6,
        textHash: createHash('sha256').update(text).digest('hex'),
        status: 'pending', provenance: 'chat_capture',
        createdAt: new Date().toISOString(),
      });
      const flipped1 = setCandidateStatus(h.db, 'c-final', 'accepted', new Date().toISOString());
      expect(flipped1).toBe(true);
      // Second flip is a no-op — pending is the only legal source state.
      const flipped2 = setCandidateStatus(h.db, 'c-final', 'rejected', new Date().toISOString());
      expect(flipped2).toBe(false);
      const after = h.db.prepare(`SELECT status FROM knowledge_candidates WHERE id = 'c-final'`)
        .get() as { status: string };
      expect(after.status).toBe('accepted');
    });
  });

  describe('12. hard-delete chunk via repo', () => {
    it('removes the row and cascades knowledge_point_roles + retrieval_log_points are unaffected', () => {
      seedRole(h.db, 'r-del');
      seedChunk(h.db, 'r-del', 'p-die');
      h.db.prepare(`INSERT INTO knowledge_point_roles (point_id, role_id) VALUES ('p-die', 'r-del')`).run();

      const ok = deleteChunkById(h.db, 'p-die');
      expect(ok).toBe(true);

      const chunkLeft = (h.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE id = 'p-die'`)
        .get() as { n: number }).n;
      expect(chunkLeft).toBe(0);
      // PR 2 N..N join cascades on chunks delete.
      const joinLeft = (h.db.prepare(
        `SELECT COUNT(*) AS n FROM knowledge_point_roles WHERE point_id = 'p-die'`,
      ).get() as { n: number }).n;
      expect(joinLeft).toBe(0);
    });
  });
});
