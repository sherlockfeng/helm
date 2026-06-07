/**
 * E2e — migration v20 attack variants.
 *
 * Per AGENTS.md §1 attack matrix and design doc PR 2 row:
 *   ≥3 of: external dep failure / concurrency race / timeout /
 *          corrupt input / boundary value.
 *
 * Variants exercised below:
 *   - Corrupt JSON inside `source` / `leg_contrib` columns (the only
 *     two surfaces where we still accept JSON-in-TEXT). Reads must
 *     degrade gracefully, never throw.
 *   - Stale-version conflict between Helm UI and Cursor MCP writing
 *     the same chunk concurrently (G4 optimistic lock, the headline
 *     reason PR 2 introduced edit_version).
 *   - Missing FK target — adding an alias for a non-existent chunk
 *     fails fast, doesn't leave orphaned rows.
 *   - Concurrent N..N writes against the same point — both succeed
 *     idempotently, point ends up with both role bindings.
 *   - Boundary: very long retrieval point lists (>100 results) round-trip
 *     in a single transaction without exceeding SQLite parameter limits.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import {
  attachRoleToPoint,
  getRolesForPoint,
} from '../../../src/storage/repos/knowledge-point-roles.js';
import { insertAlias } from '../../../src/storage/repos/knowledge-point-alias.js';
import {
  getPointsForRetrieval,
  recordRetrieval,
} from '../../../src/storage/repos/retrieval-log.js';
import { updateChunkWithVersionCheck } from '../../../src/storage/repos/roles.js';
import { getChunkById } from '../../../src/storage/repos/roles.js';

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

describe('e2e migration v20 — attacks', () => {
  let h: E2eHarness;
  beforeEach(async () => { h = await bootE2e(); });
  afterEach(async () => { await h.shutdown(); });

  it('reads with corrupt JSON in `knowledge_chunks.source` do not throw', () => {
    seedRoleAndChunk(h.db, 'r-1', 'p-bad');
    // Direct UPDATE bypasses the typed writer, simulating a partial
    // write or a row dumped in from a buggy importer.
    h.db.prepare(`UPDATE knowledge_chunks SET source = 'not-json{{' WHERE id = 'p-bad'`).run();
    const chunk = getChunkById(h.db, 'p-bad');
    expect(chunk).toBeDefined();
    expect(chunk!.source).toBeUndefined();  // silently treated as missing
    expect(chunk!.chunkText).toBe('initial body'); // rest of the row still reads
  });

  it('Cursor-MCP-and-UI race: stale-version write rejected, first writer wins', () => {
    seedRoleAndChunk(h.db, 'r-1', 'p-race');
    // Both writers read at v=1.
    const cursorWrite = updateChunkWithVersionCheck(h.db, 'p-race', 1, {
      title: 'MCP write',
    });
    expect(cursorWrite.applied).toBe(true);

    const uiWrite = updateChunkWithVersionCheck(h.db, 'p-race', 1, {
      title: 'UI write',
    });
    expect(uiWrite.applied).toBe(false);

    const final = h.db.prepare(`SELECT title, edit_version FROM knowledge_chunks WHERE id = 'p-race'`)
      .get() as { title: string; edit_version: number };
    expect(final.title).toBe('MCP write');
    expect(final.edit_version).toBe(2);
  });

  it('alias against a non-existent point is rejected by FK (no orphan)', () => {
    expect(() => insertAlias(h.db, 'p-does-not-exist', 'X', 'manual'))
      .toThrow(/FOREIGN KEY/i);
    const cnt = h.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_point_alias`).get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('concurrent N..N attaches against the same point both succeed idempotently', () => {
    seedRoleAndChunk(h.db, 'r-a', 'p-shared');
    seedRoleAndChunk(h.db, 'r-b', 'p-other');
    // Simulate two writers in a near-race: each attaches a different
    // role to the same point; the second writer ALSO attempts to
    // re-attach r-a as a way to model "duplicate accept" coming from
    // a different code path. Both should converge to the union.
    attachRoleToPoint(h.db, 'p-shared', 'r-a');
    attachRoleToPoint(h.db, 'p-shared', 'r-b');
    attachRoleToPoint(h.db, 'p-shared', 'r-a'); // duplicate from writer #1 retry
    expect(getRolesForPoint(h.db, 'p-shared').sort()).toEqual(['r-a', 'r-b']);
  });

  it('large retrieval point list (>100 hits) round-trips in a single tx', () => {
    seedRoleAndChunk(h.db, 'r-1', 'seed');
    for (let i = 0; i < 150; i++) {
      h.db.prepare(`
        INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
        VALUES (?, 'r-1', ?, 'spec', '2026-06-06T00:00:00Z')
      `).run(`p-big-${i}`, `body-${i}`);
    }
    h.db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-big', 'cursor', 'cursor', 'active', '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
    `).run();
    const points = Array.from({ length: 150 }, (_, i) => ({
      pointId: `p-big-${i}`,
      rank: i,
      fusionScore: 1 - i / 200,
      injected: i < 5, // only top-5 ever make it to context
    }));
    recordRetrieval(h.db, {
      id: 'log-big', hostSessionId: 's-big', turn: 1,
      queryText: 'big query', ts: Date.now(),
    }, points);
    const read = getPointsForRetrieval(h.db, 'log-big');
    expect(read).toHaveLength(150);
    expect(read.filter((p) => p.injected)).toHaveLength(5);
  });
});
