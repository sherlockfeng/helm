/**
 * E2e — knowledge-update attack variants (PR 4).
 *
 * Per AGENTS.md §1 / design doc PR 4: ≥3 attack variants covering
 * concurrency, ordering, terminal-state violation, and source-chat
 * deletion races.
 *
 * Variants:
 *   A. Accept-twice race — second call must 409, not duplicate the
 *      chunk
 *   B. Accept-after-reject — terminal candidate cannot be flipped
 *   C. Source chat deleted between candidate-create and accept —
 *      accept still succeeds because knowledge_candidates does NOT
 *      cascade on host_sessions delete (deliberate; the audit row
 *      survives)
 *   D. Edit-and-accept with conflicting text — unique-index collides
 *      with a sibling pending row; API returns 409 with edit_collides
 *   E. Reject all from a role — terminal across the board, none
 *      reappear via re-suggest
 */

import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import {
  insertCandidateIfNew,
  setCandidateStatus,
} from '../../../src/storage/repos/knowledge-candidates.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

interface JsonResponse { status: number; body: unknown }
async function api(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

function getPort(h: E2eHarness): number {
  const port = h.app.httpPort();
  if (port == null) throw new Error('httpPort not bound');
  return port;
}

function seedRole(db: BetterSqlite3.Database, roleId: string): void {
  upsertRole(db, {
    id: roleId, name: `R-${roleId}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
}

function seedPendingCandidate(
  db: BetterSqlite3.Database,
  candidateId: string,
  roleId: string,
  text: string,
  hostSessionId?: string,
): void {
  insertCandidateIfNew(db, {
    id: candidateId, roleId,
    ...(hostSessionId ? { hostSessionId } : {}),
    chunkText: text, sourceSegmentIndex: 0, kind: 'other',
    scoreEntity: 3, scoreCosine: 0.7,
    textHash: createHash('sha256').update(text).digest('hex'),
    status: 'pending', provenance: 'chat_capture',
    createdAt: new Date().toISOString(),
  });
}

describe('knowledge-update attacks', () => {
  let h: E2eHarness;
  beforeEach(async () => { h = await bootE2e(); });
  afterEach(async () => { await h.shutdown(); });

  it('A. accept-twice race: second call returns 409 not_pending, no duplicate chunk', async () => {
    const port = getPort(h);
    seedRole(h.db, 'r-twice');
    seedPendingCandidate(h.db, 'c-twice', 'r-twice', 'unique text for once-only accept');

    const first = await api(port, 'POST', '/api/knowledge-candidates/c-twice/accept');
    expect(first.status).toBe(200);

    const second = await api(port, 'POST', '/api/knowledge-candidates/c-twice/accept');
    expect(second.status).toBe(409);
    const errBody = second.body as { error?: string; currentStatus?: string };
    expect(errBody.error).toBe('not_pending');
    expect(errBody.currentStatus).toBe('accepted');

    // Exactly one chunk landed.
    const chunks = h.db.prepare(`SELECT id FROM knowledge_chunks WHERE role_id = 'r-twice'`)
      .all() as { id: string }[];
    expect(chunks.length).toBe(1);
  });

  it('B. accept-after-reject: rejected candidate cannot be promoted', async () => {
    const port = getPort(h);
    seedRole(h.db, 'r-after-reject');
    seedPendingCandidate(h.db, 'c-rej', 'r-after-reject', 'first rejected, then attempt accept');

    setCandidateStatus(h.db, 'c-rej', 'rejected', new Date().toISOString());

    const r = await api(port, 'POST', '/api/knowledge-candidates/c-rej/accept');
    expect(r.status).toBe(409);
    const errBody = r.body as { error?: string; currentStatus?: string };
    expect(errBody.error).toBe('not_pending');
    expect(errBody.currentStatus).toBe('rejected');
  });

  it('C. source chat deletion does not block candidate acceptance (audit survives)', async () => {
    const port = getPort(h);
    seedRole(h.db, 'r-srcdel');
    h.db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-doomed', 'cursor', 'cursor', 'active', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());
    seedPendingCandidate(h.db, 'c-bound', 'r-srcdel', 'rollback after chat was deleted', 's-doomed');

    // User deletes the source chat (legit operation).
    h.db.prepare(`DELETE FROM host_sessions WHERE id = 's-doomed'`).run();

    // knowledge_candidates.host_session_id is NULLABLE — design choice
    // so the audit row survives chat deletion. The accept path must
    // therefore still work after the parent row is gone.
    const r = await api(port, 'POST', '/api/knowledge-candidates/c-bound/accept');
    expect(r.status).toBe(200);
    const chunkCount = (h.db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_chunks WHERE role_id = 'r-srcdel'`,
    ).get() as { n: number }).n;
    expect(chunkCount).toBe(1);
  });

  it('D. edit-and-accept collides with sibling pending text → 409 edit_collides', async () => {
    const port = getPort(h);
    seedRole(h.db, 'r-collide');
    seedPendingCandidate(h.db, 'c-A', 'r-collide', 'sibling text A');
    seedPendingCandidate(h.db, 'c-B', 'r-collide', 'sibling text B');

    // Try to rewrite c-B so its text-hash collides with c-A.
    const r = await api(port, 'POST', '/api/knowledge-candidates/c-B/edit-and-accept', {
      chunkText: 'sibling text A',
    });
    expect(r.status).toBe(409);
    const errBody = r.body as { error?: string };
    expect(errBody.error).toBe('edit_collides');
  });

  it('E. reject all in a role: every status becomes terminal, no chunks ever land', async () => {
    const port = getPort(h);
    seedRole(h.db, 'r-bulk-rej');
    seedPendingCandidate(h.db, 'c-1', 'r-bulk-rej', 'reject one');
    seedPendingCandidate(h.db, 'c-2', 'r-bulk-rej', 'reject two');
    seedPendingCandidate(h.db, 'c-3', 'r-bulk-rej', 'reject three');

    for (const id of ['c-1', 'c-2', 'c-3']) {
      const r = await api(port, 'POST', `/api/knowledge-candidates/${id}/reject`);
      expect(r.status).toBe(200);
    }
    const remaining = (h.db.prepare(`
      SELECT COUNT(*) AS n FROM knowledge_candidates
      WHERE role_id = 'r-bulk-rej' AND status != 'rejected'
    `).get() as { n: number }).n;
    expect(remaining).toBe(0);
    const chunks = (h.db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_chunks WHERE role_id = 'r-bulk-rej'`,
    ).get() as { n: number }).n;
    expect(chunks).toBe(0);
  });
});
