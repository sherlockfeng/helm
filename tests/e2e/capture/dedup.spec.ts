/**
 * Capture e2e — dedup behavior.
 *
 * Pins:
 *   - same response fired twice for the same chat+role → only one candidate
 *   - rejected candidate blocks re-suggestion of the same text (Decision §8)
 *   - cross-role dedup is OFF — same text generates candidates for each
 *     role independently
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { trainRole } from '../../../src/roles/library.js';
import { captureFromAgentResponse } from '../../../src/capture/index.js';
import {
  listCandidatesForRole,
  setCandidateStatus,
} from '../../../src/storage/repos/knowledge-candidates.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';

const RESPONSE = [
  'When rotating the RBAC roles and the CSR signer, redeploy every TCE',
  'pod in a specific order to avoid the staggered fallback bug.',
  'Drain leader → scale-down followers → reseed CSR cache → kick the RBAC sync.',
].join(' ');

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

async function trainRBACRole(
  db: BetterSqlite3.Database,
  roleId: string,
  embedFn: (t: string) => Promise<Float32Array>,
): Promise<void> {
  await trainRole(db, {
    roleId, name: roleId,
    documents: [{
      filename: 'rbac.md',
      content: 'RBAC config drives access. CSR signing is required for TCE clusters.',
      kind: 'spec',
    }],
    embedFn,
  });
}

describe('capture e2e — dedup', () => {
  let db: BetterSqlite3.Database;
  const embedFn = makePseudoEmbedFn();
  beforeEach(async () => {
    db = openDb();
    upsertHostSession(db, {
      id: 'chat-1', host: 'cursor', status: 'active',
      firstSeenAt: '2026-05-14', lastSeenAt: '2026-05-14',
    });
    await trainRBACRole(db, 'rA', embedFn);
  });
  afterEach(() => { db.close(); });

  it('same response fired twice → only one candidate (reviewer #6: id-set equality)', async () => {
    const r1 = await captureFromAgentResponse({
      db, hostSessionId: 'chat-1', roleIds: ['rA'],
      responseText: RESPONSE, embedFn,
    });
    expect(r1.candidatesCreated).toBeGreaterThanOrEqual(1);
    // Snapshot the exact ID set, not just the count — would catch a
    // regression where pass 2 inserted a new row that displaced an
    // old one (count stays equal, identities silently rotate).
    const idsBefore = new Set(listCandidatesForRole(db, 'rA').map((c) => c.id));

    const r2 = await captureFromAgentResponse({
      db, hostSessionId: 'chat-1', roleIds: ['rA'],
      responseText: RESPONSE, embedFn,
    });
    expect(r2.candidatesCreated).toBe(0); // all dedup'd
    const idsAfter = new Set(listCandidatesForRole(db, 'rA').map((c) => c.id));
    expect(idsAfter).toEqual(idsBefore);
  });

  it('rejected candidate blocks re-suggestion (§8: reject is terminal)', async () => {
    const r1 = await captureFromAgentResponse({
      db, hostSessionId: 'chat-1', roleIds: ['rA'],
      responseText: RESPONSE, embedFn,
    });
    expect(r1.candidatesCreated).toBeGreaterThanOrEqual(1);
    const cand = listCandidatesForRole(db, 'rA')[0]!;
    setCandidateStatus(db, cand.id, 'rejected', new Date().toISOString());

    // Same response again → the rejected row blocks re-insert.
    const r2 = await captureFromAgentResponse({
      db, hostSessionId: 'chat-1', roleIds: ['rA'],
      responseText: RESPONSE, embedFn,
    });
    expect(r2.candidatesCreated).toBe(0);
  });

  it('cross-role: same response generates candidates for each bound role independently', async () => {
    await trainRBACRole(db, 'rB', embedFn);
    const r = await captureFromAgentResponse({
      db, hostSessionId: 'chat-1', roleIds: ['rA', 'rB'],
      responseText: RESPONSE, embedFn,
    });
    const rA = r.byRole.find((x) => x.roleId === 'rA')!;
    const rB = r.byRole.find((x) => x.roleId === 'rB')!;
    expect(rA.inserted).toBeGreaterThanOrEqual(1);
    expect(rB.inserted).toBeGreaterThanOrEqual(1);
  });
});
