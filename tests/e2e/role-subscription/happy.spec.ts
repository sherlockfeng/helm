/**
 * Role subscription end-to-end (Phase 79).
 *
 * Walks the full user flow:
 *   1. Train a "source" role on machine A
 *   2. Export → write bundle to a file:// URL (simulates TOS upload)
 *   3. On machine B (separate db), create a "target" role + subscription
 *   4. Run sync → bundle pulled, diff produces candidates
 *   5. Mutate source bundle (re-export with new content) → run sync again
 *      → new candidates appear for the changed chunks
 *   6. Re-run sync with no changes → noop / unchanged
 */

import BetterSqlite3 from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { trainRole, updateRole } from '../../../src/roles/library.js';
import {
  bundleToBytes,
  packRole,
} from '../../../src/roles/bundle.js';
import {
  fileStoragePlugin,
  PluginRegistry,
} from '../../../src/plugins/index.js';
import { runSubscriptionSync } from '../../../src/subscriptions/sync.js';
import {
  getSubscription,
  insertSubscription,
} from '../../../src/storage/repos/role-subscriptions.js';
import { listCandidatesForRole } from '../../../src/storage/repos/knowledge-candidates.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let workDir: string;
beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'helm-subscription-e2e-'));
});
afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('role-subscription e2e — bundle flows through file:// as if it were TOS', () => {
  const embedFn = makePseudoEmbedFn();

  it('train → export → subscribe → sync → candidates land on target; second sync sees changes; third sync is noop', async () => {
    const bundlePath = join(workDir, 'goofy.helmrole');
    const bundleUrl = pathToFileURL(bundlePath).href;

    // ── Machine A: train + export ──────────────────────────────────
    const dbA = openDb();
    try {
      await trainRole(dbA, {
        roleId: 'goofy', name: 'Goofy expert',
        documents: [
          { filename: 'arch.md', content: 'Goofy 服务架构总览：API → router → handler。'
            + ' Long enough text to pass the splitter floor. ' + 'x'.repeat(80), kind: 'spec' },
        ],
        embedFn,
      });
      await fs.writeFile(bundlePath, bundleToBytes(packRole(dbA, 'goofy')));
    } finally { dbA.close(); }

    // ── Machine B: subscribe + sync ────────────────────────────────
    const dbB = openDb();
    try {
      await trainRole(dbB, { roleId: 'goofy', name: 'Goofy expert', documents: [], embedFn });
      insertSubscription(dbB, {
        id: 'sub-goofy', roleId: 'goofy', sourceType: 'file', sourceUrl: bundleUrl,
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      registry.registerOk(fileStoragePlugin, '<built-in>');

      // First sync — pulls bundle, creates candidates.
      const r1 = await runSubscriptionSync({ db: dbB, registry });
      expect(r1[0]?.action).toBe('applied');
      expect(r1[0]?.candidatesCreated).toBeGreaterThan(0);
      const candsAfterFirst = listCandidatesForRole(dbB, 'goofy', { status: 'pending' });
      expect(candsAfterFirst.length).toBeGreaterThan(0);
      expect(candsAfterFirst.every((c) => c.provenance === 'subscription')).toBe(true);

      // Re-sync with no remote change — noop. Use subscriptionId to
      // bypass the "due" filter; an immediate re-sync would otherwise
      // not be picked up (sync_interval=60min not elapsed).
      const r2 = await runSubscriptionSync({ db: dbB, registry }, { subscriptionId: 'sub-goofy' });
      expect(r2[0]?.action).toBe('noop');

      // ── Mutate the bundle on disk: machine A re-exports with new chunk ──
      const dbA2 = openDb();
      try {
        await trainRole(dbA2, {
          roleId: 'goofy', name: 'Goofy expert',
          documents: [
            { filename: 'arch.md', content: 'Goofy 服务架构总览：API → router → handler。'
              + ' Long enough text to pass the splitter floor. ' + 'x'.repeat(80), kind: 'spec' },
            { filename: 'newdoc.md', content: 'NEW chunk content peer added — long enough to clear the splitter floor. ' + 'y'.repeat(80), kind: 'runbook' },
          ],
          embedFn,
        });
        await fs.writeFile(bundlePath, bundleToBytes(packRole(dbA2, 'goofy')));
      } finally { dbA2.close(); }

      const r3 = await runSubscriptionSync({ db: dbB, registry }, { subscriptionId: 'sub-goofy' });
      expect(r3[0]?.action).toBe('applied');
      // At least one new candidate (the "NEW chunk content").
      expect(r3[0]?.candidatesCreated).toBeGreaterThanOrEqual(1);
      const candsAfterThird = listCandidatesForRole(dbB, 'goofy', { status: 'pending' });
      expect(candsAfterThird.some((c) => c.chunkText.includes('NEW chunk content'))).toBe(true);

      const sub = getSubscription(dbB, 'sub-goofy')!;
      expect(sub.status).toBe('active');
      expect(sub.lastEtag).toBeTruthy();
      expect(sub.lastContentHash).toBeTruthy();
    } finally { dbB.close(); }
  });

  it('accept a subscription candidate → role chunk count grows', async () => {
    const bundlePath = join(workDir, 'r.helmrole');
    const bundleUrl = pathToFileURL(bundlePath).href;

    const dbA = openDb();
    try {
      await trainRole(dbA, {
        roleId: 'src', name: 'src',
        documents: [{
          filename: 's.md',
          content: 'sharable knowledge segment '
            + 'long enough to clear the splitter min floor. ' + 'z'.repeat(80),
          kind: 'spec',
        }],
        embedFn,
      });
      await fs.writeFile(bundlePath, bundleToBytes(packRole(dbA, 'src')));
    } finally { dbA.close(); }

    const dbB = openDb();
    try {
      await trainRole(dbB, { roleId: 'src', name: 'src', documents: [], embedFn });
      insertSubscription(dbB, {
        id: 'sub-1', roleId: 'src', sourceType: 'file', sourceUrl: bundleUrl,
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      registry.registerOk(fileStoragePlugin, '<built-in>');

      await runSubscriptionSync({ db: dbB, registry });
      const cands = listCandidatesForRole(dbB, 'src', { status: 'pending' });
      expect(cands.length).toBe(1);
      const cand = cands[0]!;

      const beforeCount = dbB.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE role_id = ?`)
        .get('src') as { n: number };
      // Accept via updateRole (force=true to bypass Phase 66 conflict UI).
      await updateRole(dbB, {
        roleId: 'src',
        appendDocuments: [{
          filename: `capture-${cand.id}`,
          content: cand.chunkText,
          kind: cand.kind,
          sourceKind: 'inline',
          origin: `subscription-${cand.id}`,
        }],
        embedFn,
        force: true,
      });
      const afterCount = dbB.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE role_id = ?`)
        .get('src') as { n: number };
      expect(afterCount.n).toBeGreaterThan(beforeCount.n);
    } finally { dbB.close(); }
  });
});
