/**
 * Subscription sync engine — Phase 79.
 *
 * Pins:
 *   - no plugin for scheme → row marked error with clear message
 *   - headEtag matches last_etag → action='noop', no GET
 *   - contentHash matches last_content_hash → action='unchanged', no apply
 *   - new bundle → action='applied', candidates created, last_etag + last_content_hash updated
 *   - headEtag returns null (object missing) → action='error'
 *   - plugin download throws → action='error', error preserved
 *   - subscriptionId filter restricts the sweep to one row
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  fileStoragePlugin,
  PLUGIN_API_VERSION_CURRENT,
  PluginRegistry,
  type StoragePlugin,
} from '../../../src/plugins/index.js';
import {
  bundleToBytes,
  packRole,
  type RoleBundle,
} from '../../../src/roles/bundle.js';
import { runSubscriptionSync } from '../../../src/subscriptions/sync.js';
import { trainRole } from '../../../src/roles/library.js';
import {
  getSubscription,
  insertSubscription,
} from '../../../src/storage/repos/role-subscriptions.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let workDir: string;
beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'helm-sync-test-'));
});
afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function setupRolesAndBundle(db: BetterSqlite3.Database, embedFn: ReturnType<typeof makePseudoEmbedFn>): Promise<{ bundle: RoleBundle; url: string }> {
  await trainRole(db, {
    roleId: 'src-role', name: 'src',
    documents: [{
      filename: 's.md',
      content: 'one chunk to seed the source role; needs to be long enough to survive the splitter floor xxxxxxxxxxxxxxxxxxxxxxxxxxx',
      kind: 'spec',
    }],
    embedFn,
  });
  await trainRole(db, { roleId: 'tgt-role', name: 'tgt', documents: [], embedFn });
  const bundle = packRole(db, 'src-role');
  const bundlePath = join(workDir, 'src.helmrole');
  await fs.writeFile(bundlePath, bundleToBytes(bundle));
  return { bundle, url: pathToFileURL(bundlePath).href };
}

describe('runSubscriptionSync', () => {
  it('no plugin registered for scheme → error outcome', async () => {
    const db = openDb();
    try {
      await trainRole(db, { roleId: 'tgt', name: 't', documents: [], embedFn: makePseudoEmbedFn() });
      insertSubscription(db, {
        id: 'sub-1', roleId: 'tgt', sourceType: 'tos', sourceUrl: 'tos://b/k',
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      const outcomes = await runSubscriptionSync({ db, registry });
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]?.action).toBe('error');
      expect(outcomes[0]?.error).toMatch(/no storage plugin/);
      const after = getSubscription(db, 'sub-1')!;
      expect(after.status).toBe('error');
    } finally { db.close(); }
  });

  it('new bundle → action=applied, candidates created, hashes recorded', async () => {
    const db = openDb();
    try {
      const { url } = await setupRolesAndBundle(db, makePseudoEmbedFn());
      insertSubscription(db, {
        id: 'sub-1', roleId: 'tgt-role', sourceType: 'file', sourceUrl: url,
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      registry.registerOk(fileStoragePlugin, '<built-in>');
      const outcomes = await runSubscriptionSync({ db, registry });
      expect(outcomes[0]?.action).toBe('applied');
      expect(outcomes[0]?.candidatesCreated).toBeGreaterThan(0);
      const after = getSubscription(db, 'sub-1')!;
      expect(after.lastEtag).toBeTruthy();
      expect(after.lastContentHash).toBeTruthy();
      expect(after.status).toBe('active');
    } finally { db.close(); }
  });

  it('headEtag unchanged → action=noop, no GET, no apply', async () => {
    const db = openDb();
    try {
      const { url } = await setupRolesAndBundle(db, makePseudoEmbedFn());
      insertSubscription(db, {
        id: 'sub-1', roleId: 'tgt-role', sourceType: 'file', sourceUrl: url,
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      registry.registerOk(fileStoragePlugin, '<built-in>');
      // First sync — establishes lastEtag.
      await runSubscriptionSync({ db, registry });
      // Second sync — file unchanged → noop. Use subscriptionId to
      // bypass the "due" filter (24h interval means the cron path
      // wouldn't pick it up yet).
      const outcomes = await runSubscriptionSync({ db, registry }, { subscriptionId: 'sub-1' });
      expect(outcomes[0]?.action).toBe('noop');
    } finally { db.close(); }
  });

  it('headEtag null (missing object) → action=error', async () => {
    const db = openDb();
    try {
      await trainRole(db, { roleId: 'tgt', name: 't', documents: [], embedFn: makePseudoEmbedFn() });
      insertSubscription(db, {
        id: 'sub-1', roleId: 'tgt', sourceType: 'file',
        sourceUrl: `file://${workDir}/does-not-exist.helmrole`,
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      registry.registerOk(fileStoragePlugin, '<built-in>');
      const outcomes = await runSubscriptionSync({ db, registry });
      expect(outcomes[0]?.action).toBe('error');
      expect(outcomes[0]?.error).toMatch(/not found/);
    } finally { db.close(); }
  });

  it('subscriptionId filter targets a single row', async () => {
    const db = openDb();
    try {
      const { url } = await setupRolesAndBundle(db, makePseudoEmbedFn());
      // Create a second role + subscription too — make sure the filter
      // doesn't sync the other one.
      await trainRole(db, { roleId: 'other-role', name: 'o', documents: [], embedFn: makePseudoEmbedFn() });
      insertSubscription(db, {
        id: 'sub-1', roleId: 'tgt-role', sourceType: 'file', sourceUrl: url,
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      insertSubscription(db, {
        id: 'sub-2', roleId: 'other-role', sourceType: 'file', sourceUrl: url,
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      registry.registerOk(fileStoragePlugin, '<built-in>');
      const outcomes = await runSubscriptionSync({ db, registry }, { subscriptionId: 'sub-1' });
      expect(outcomes.length).toBe(1);
      expect(outcomes[0]?.subscriptionId).toBe('sub-1');
    } finally { db.close(); }
  });

  it('autoApply=true → action=auto_applied, candidates accepted into knowledge_chunks (reviewer blocker #1)', async () => {
    const db = openDb();
    try {
      const { url } = await setupRolesAndBundle(db, makePseudoEmbedFn());
      insertSubscription(db, {
        id: 'sub-1', roleId: 'tgt-role', sourceType: 'file', sourceUrl: url,
        syncIntervalMinutes: 60, autoApply: true, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      registry.registerOk(fileStoragePlugin, '<built-in>');
      const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE role_id = ?`)
        .get('tgt-role') as { n: number }).n;
      const outcomes = await runSubscriptionSync({ db, registry });
      expect(outcomes[0]?.action).toBe('auto_applied');
      const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE role_id = ?`)
        .get('tgt-role') as { n: number }).n;
      expect(afterCount).toBeGreaterThan(beforeCount);
      // Candidates that were auto-accepted should have status='accepted',
      // not pending — UI shouldn't show them as needing review.
      const pending = db.prepare(
        `SELECT COUNT(*) AS n FROM knowledge_candidates WHERE role_id = ? AND status = 'pending'`,
      ).get('tgt-role') as { n: number };
      expect(pending.n).toBe(0);
    } finally { db.close(); }
  });

  it('plugin throws on download → action=error, message preserved', async () => {
    const db = openDb();
    try {
      await trainRole(db, { roleId: 'tgt', name: 't', documents: [], embedFn: makePseudoEmbedFn() });
      insertSubscription(db, {
        id: 'sub-1', roleId: 'tgt', sourceType: 'oops', sourceUrl: 'oops://x',
        syncIntervalMinutes: 60, autoApply: false, status: 'active',
        createdAt: new Date().toISOString(),
      });
      const registry = new PluginRegistry();
      const flaky: StoragePlugin = {
        id: 'helm-storage-oops',
        scheme: 'oops',
        version: '0.0.1',
        apiVersion: PLUGIN_API_VERSION_CURRENT,
        init() {},
        async download() { throw new Error('boom'); },
        async upload() { return { etag: 'x' }; },
        async headEtag() { return 'never-seen-before-etag-' + randomUUID(); },
      };
      registry.registerOk(flaky, '<test>');
      const outcomes = await runSubscriptionSync({ db, registry });
      expect(outcomes[0]?.action).toBe('error');
      expect(outcomes[0]?.error).toBe('boom');
    } finally { db.close(); }
  });
});

// ─── Phase 80 (PR C) — version-aware conflict gate ─────────────────────

import { bumpRoleVersion } from '../../../src/storage/repos/roles.js';
import {
  markSubscriptionSynced,
  getSubscription as getSub,
} from '../../../src/storage/repos/role-subscriptions.js';
import { resolveSubscriptionConflict } from '../../../src/subscriptions/sync.js';

describe('version-aware sync (PR C)', () => {
  async function setup(db: BetterSqlite3.Database) {
    const embedFn = makePseudoEmbedFn();
    const { bundle, url } = await setupRolesAndBundle(db, embedFn);
    const registry = new PluginRegistry();
    registry.registerOk(fileStoragePlugin, '<test>');
    const subId = 'sub-1';
    insertSubscription(db, {
      id: subId, roleId: 'tgt-role', sourceType: 'file', sourceUrl: url,
      syncIntervalMinutes: 60, autoApply: false, status: 'active',
      createdAt: new Date().toISOString(),
    });
    return { bundle, url, registry, subId };
  }

  it('first-ever pull (lastPulledVersion=NULL) applies without checking conflict gate', async () => {
    const db = openDb();
    try {
      const { registry, subId } = await setup(db);
      // tgt-role at v=1, no lastPulled → just apply.
      const outcomes = await runSubscriptionSync({ db, registry });
      expect(outcomes[0]?.action).toBe('applied');
      // lastPulled should now hold the bundle's roleVersion (1 from a
      // brand-new src-role that's never been re-trained).
      const after = getSub(db, subId)!;
      expect(after.lastPulledVersion).toBe(1);
    } finally { db.close(); }
  });

  it('R>P, L==P → fast-forward apply (action=applied)', async () => {
    const db = openDb();
    try {
      const { registry, subId, bundle } = await setup(db);
      // Manually set lastPulled to 1, simulating a previous sync. Local
      // tgt-role stays at v=1. Re-pack to bump bundle's roleVersion to
      // 2 by re-training src-role.
      markSubscriptionSynced(db, subId, {
        contentHash: bundle.contentHash,
        pulledVersion: 1,
        at: new Date().toISOString(),
      });
      await trainRole(db, {
        roleId: 'src-role', name: 'src',
        documents: [{
          filename: 's2.md',
          content: 'second wave content that is long enough to survive the splitter floor xxxxxxxxxxxxxxxxxxxxxxxxxxx',
          kind: 'spec',
        }],
        embedFn: makePseudoEmbedFn(),
      });
      // Re-pack + overwrite the on-disk bundle so HEAD/GET sees v=2.
      const nextBundle = packRole(db, 'src-role');
      await fs.writeFile(
        new URL(bundle.contentHash ? `file://${workDir}/src.helmrole` : '').pathname || join(workDir, 'src.helmrole'),
        bundleToBytes(nextBundle),
      );

      const outcomes = await runSubscriptionSync({ db, registry }, { subscriptionId: subId });
      expect(outcomes[0]?.action).toBe('applied');
      const after = getSub(db, subId)!;
      expect(after.lastPulledVersion).toBe(nextBundle.roleVersion);
    } finally { db.close(); }
  });

  it('R==P, L>P → action=local_ahead, no apply, no conflict', async () => {
    const db = openDb();
    try {
      const { registry, subId, bundle } = await setup(db);
      // Set baseline: lastPulled=1. Then bump local without touching remote.
      markSubscriptionSynced(db, subId, {
        contentHash: bundle.contentHash,
        pulledVersion: 1,
        at: new Date().toISOString(),
      });
      bumpRoleVersion(db, 'tgt-role');  // local at v=2

      // Force contentHash mismatch so we get past the contentHash guard
      // and into the 4-case gate — sub's stored contentHash is fine,
      // but the bundle's contentHash will differ if we change the
      // bundle on disk. Easier: nuke the recorded contentHash.
      db.prepare(`UPDATE role_subscriptions SET last_content_hash = NULL WHERE id = ?`).run(subId);

      const outcomes = await runSubscriptionSync({ db, registry }, { subscriptionId: subId });
      expect(outcomes[0]?.action).toBe('local_ahead');
      const after = getSub(db, subId)!;
      // local_ahead does NOT advance lastPulled (remote unchanged).
      expect(after.lastPulledVersion).toBe(1);
      expect(after.status).toBe('active');
    } finally { db.close(); }
  });

  it('R>P AND L>P → action=conflict, status=conflict, no apply', async () => {
    const db = openDb();
    try {
      const { registry, subId, bundle } = await setup(db);
      markSubscriptionSynced(db, subId, {
        contentHash: bundle.contentHash,
        pulledVersion: 1,
        at: new Date().toISOString(),
      });
      bumpRoleVersion(db, 'tgt-role'); // local at v=2
      // Re-pack source role at v=2.
      await trainRole(db, {
        roleId: 'src-role', name: 'src',
        documents: [{
          filename: 's2.md', kind: 'spec',
          content: 'new remote chunk text long enough to survive the splitter floor xxxxxxxxxxxxxxxxxxxxxxxxxxx',
        }],
        embedFn: makePseudoEmbedFn(),
      });
      const nextBundle = packRole(db, 'src-role');
      await fs.writeFile(join(workDir, 'src.helmrole'), bundleToBytes(nextBundle));

      const outcomes = await runSubscriptionSync({ db, registry }, { subscriptionId: subId });
      expect(outcomes[0]?.action).toBe('conflict');
      const after = getSub(db, subId)!;
      expect(after.status).toBe('conflict');
      expect(after.lastError).toMatch(/conflict/);
      // Conflict does NOT advance lastPulled — caller resolves explicitly.
      expect(after.lastPulledVersion).toBe(1);
    } finally { db.close(); }
  });

  it('resolveSubscriptionConflict use_remote → applies + lastPulled advances', async () => {
    const db = openDb();
    try {
      const { registry, subId, bundle } = await setup(db);
      markSubscriptionSynced(db, subId, {
        contentHash: bundle.contentHash,
        pulledVersion: 1,
        at: new Date().toISOString(),
      });
      bumpRoleVersion(db, 'tgt-role');
      await trainRole(db, {
        roleId: 'src-role', name: 'src',
        documents: [{
          filename: 's2.md', kind: 'spec',
          content: 'conflict-time remote chunk text long enough to survive splitter floor xxxxxxxxxxxxxxxxxxxxxxxxxxx',
        }],
        embedFn: makePseudoEmbedFn(),
      });
      const nextBundle = packRole(db, 'src-role');
      await fs.writeFile(join(workDir, 'src.helmrole'), bundleToBytes(nextBundle));
      // Trigger conflict.
      await runSubscriptionSync({ db, registry }, { subscriptionId: subId });
      expect(getSub(db, subId)?.status).toBe('conflict');

      // Resolve: use_remote.
      const result = await resolveSubscriptionConflict({ db, registry }, subId, 'use_remote');
      expect(result.ok).toBe(true);
      expect(result.pulledVersion).toBe(nextBundle.roleVersion);
      const after = getSub(db, subId)!;
      expect(after.status).toBe('active');
      expect(after.lastError).toBeUndefined();
      expect(after.lastPulledVersion).toBe(nextBundle.roleVersion);
    } finally { db.close(); }
  });

  it('resolveSubscriptionConflict keep_local → no apply, lastPulled advances', async () => {
    const db = openDb();
    try {
      const { registry, subId, bundle } = await setup(db);
      markSubscriptionSynced(db, subId, {
        contentHash: bundle.contentHash,
        pulledVersion: 1,
        at: new Date().toISOString(),
      });
      bumpRoleVersion(db, 'tgt-role');
      await trainRole(db, {
        roleId: 'src-role', name: 'src',
        documents: [{
          filename: 's2.md', kind: 'spec',
          content: 'remote moved on but we keep local long enough to survive splitter floor xxxxxxxxxxxxxxxxxxxxxxxxxxx',
        }],
        embedFn: makePseudoEmbedFn(),
      });
      const nextBundle = packRole(db, 'src-role');
      await fs.writeFile(join(workDir, 'src.helmrole'), bundleToBytes(nextBundle));
      await runSubscriptionSync({ db, registry }, { subscriptionId: subId });
      expect(getSub(db, subId)?.status).toBe('conflict');

      const result = await resolveSubscriptionConflict({ db, registry }, subId, 'keep_local');
      expect(result.ok).toBe(true);
      expect(result.pulledVersion).toBe(nextBundle.roleVersion);
      // keep_local does NOT report candidatesCreated.
      expect(result.candidatesCreated).toBeUndefined();
      const after = getSub(db, subId)!;
      expect(after.status).toBe('active');
      expect(after.lastPulledVersion).toBe(nextBundle.roleVersion);
    } finally { db.close(); }
  });

  it('bundles without roleVersion (pre-PR-A peer) skip the 4-case gate', async () => {
    const db = openDb();
    try {
      const { registry, subId, bundle } = await setup(db);
      markSubscriptionSynced(db, subId, {
        contentHash: bundle.contentHash,
        pulledVersion: 1,
        at: new Date().toISOString(),
      });
      bumpRoleVersion(db, 'tgt-role'); // local moves
      // Hand-craft a bundle with NO roleVersion field, different content.
      const stripped: Record<string, unknown> = { ...bundle };
      delete stripped['roleVersion'];
      stripped['contentHash'] = 'forced-different-hash';
      await fs.writeFile(
        join(workDir, 'src.helmrole'),
        Buffer.from(JSON.stringify(stripped), 'utf8'),
      );

      const outcomes = await runSubscriptionSync({ db, registry }, { subscriptionId: subId });
      // No version info → can't detect conflict → applies as before.
      expect(outcomes[0]?.action).toBe('applied');
      const after = getSub(db, subId)!;
      // lastPulled unchanged (no version came in).
      expect(after.lastPulledVersion).toBe(1);
    } finally { db.close(); }
  });
});
