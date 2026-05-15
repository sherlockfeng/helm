/**
 * Capture e2e — agent response → candidate → accept → role chunk grows.
 *
 * Drives the capture pipeline directly (without spinning HelmApp) for
 * speed: train a role, fire `captureFromAgentResponse` over a crafted
 * agent reply, verify the candidate landed, accept it via the repo
 * primitives + `updateRole`, verify the role's chunk count grew.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { trainRole, updateRole } from '../../../src/roles/library.js';
import { captureFromAgentResponse } from '../../../src/capture/index.js';
import {
  listCandidatesForRole,
  setCandidateStatus,
} from '../../../src/storage/repos/knowledge-candidates.js';
import { getChunksForRole } from '../../../src/storage/repos/roles.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('capture e2e — happy path', () => {
  let db: BetterSqlite3.Database;
  const embedFn = makePseudoEmbedFn();
  beforeEach(async () => {
    db = openDb();
    upsertHostSession(db, {
      id: 'chat-1', host: 'cursor', status: 'active',
      firstSeenAt: '2026-05-14', lastSeenAt: '2026-05-14',
    });
    await trainRole(db, {
      roleId: 'rA',
      name: 'Goofy expert',
      documents: [{
        filename: 'rbac.md',
        // Rich content — gives the entity extractor RBAC + CSR + TCE.
        content: 'RBAC config drives access. CSR signing is required for TCE clusters. '
          + 'See the RBAC + CSR + TCE diagram.',
        kind: 'spec',
      }],
      embedFn,
    });
  });
  afterEach(() => { db.close(); });

  it('agent response with matching entities → pending candidate → accept → chunk grows', async () => {
    // Long enough to survive the splitter's minSegmentChars floor. Mentions
    // RBAC + CSR + TCE so entity overlap ≥ 2 fires regardless of the
    // pseudo-embedder's cosine value.
    const response = [
      'Quick check: when you rotate the RBAC roles and CSR signer, you need to redeploy',
      'every TCE cluster pod in a specific order to avoid the staggered fallback bug.',
      'Drain leader → scale-down followers → reseed CSR cache → kick back the RBAC sync.',
    ].join(' ');

    const beforeChunks = getChunksForRole(db, 'rA').length;

    const result = await captureFromAgentResponse({
      db,
      hostSessionId: 'chat-1',
      roleIds: ['rA'],
      responseText: response,
      embedFn,
    });
    expect(result.segments).toBeGreaterThanOrEqual(1);
    expect(result.candidatesCreated).toBeGreaterThanOrEqual(1);
    expect(result.inserted[0]!.hostSessionId).toBe('chat-1');

    const pending = listCandidatesForRole(db, 'rA');
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const cand = pending[0]!;
    expect(cand.status).toBe('pending');
    expect(cand.scoreEntity).toBeGreaterThanOrEqual(2);

    // Accept via the same library path the API endpoint uses.
    await updateRole(db, {
      roleId: 'rA',
      appendDocuments: [{
        filename: `capture-${cand.id}`,
        content: cand.chunkText,
        kind: cand.kind,
        sourceKind: 'inline',
        origin: `capture-${cand.id}`,
      }],
      embedFn,
      force: true, // bypass Phase 66 conflict-detection for the test
    });
    setCandidateStatus(db, cand.id, 'accepted', new Date().toISOString());

    const afterChunks = getChunksForRole(db, 'rA').length;
    expect(afterChunks).toBeGreaterThan(beforeChunks);
  });

  it('response with no known entities AND no cosine signal → no candidate', async () => {
    // We dial the cosine threshold to ~1.0 because the pseudo-embedder
    // (char-bin) gives ~0.5-0.9 cosine between any two English sentences;
    // a 0.6 threshold isn't enough to "no signal" against arbitrary text.
    // The entity leg still uses default (≥2), and the response has no
    // overlapping entities (RBAC / CSR / TCE), so capture should skip.
    const result = await captureFromAgentResponse({
      db,
      hostSessionId: 'chat-1',
      roleIds: ['rA'],
      responseText: 'Some completely unrelated chatter about lunch options today. '
        + 'Anyone want sushi or noodles? The cafeteria menu is really good this week '
        + 'and the soup is highly recommended by several coworkers honestly.',
      embedFn,
      thresholds: { minCosine: 0.99 },
    });
    expect(result.candidatesCreated).toBe(0);
  });

  it('multiple bound roles → score independently', async () => {
    await trainRole(db, {
      roleId: 'rB',
      name: 'Unrelated',
      documents: [{
        filename: 'foo.md',
        content: 'Foo bar baz. Nothing role-A would care about. Random sentences.',
        kind: 'spec',
      }],
      embedFn,
    });
    const result = await captureFromAgentResponse({
      db,
      hostSessionId: 'chat-1',
      roleIds: ['rA', 'rB'],
      responseText: 'RBAC + CSR + TCE checklist runbook for incident response. '
        + 'Order matters: rotate CSR first then bounce the RBAC sync workers.',
      embedFn,
      // Tight cosine threshold so the char-bin pseudo-embedder doesn't
      // false-positive on rB (whose content is unrelated). Real embedders
      // wouldn't have this issue; the test pins the entity-leg behavior.
      thresholds: { minCosine: 0.99 },
    });
    // rA matches RBAC + CSR + TCE → ≥1 candidate; rB matches nothing → 0.
    const rA = result.byRole.find((r) => r.roleId === 'rA')!;
    const rB = result.byRole.find((r) => r.roleId === 'rB')!;
    expect(rA.inserted).toBeGreaterThanOrEqual(1);
    expect(rB.inserted).toBe(0);
  });

  it('empty role binding list → no work', async () => {
    const result = await captureFromAgentResponse({
      db,
      hostSessionId: 'chat-1',
      roleIds: [],
      responseText: 'Big response about RBAC + CSR + TCE — nobody listening.',
      embedFn,
    });
    expect(result.segments).toBe(0);
    expect(result.candidatesCreated).toBe(0);
  });
});
