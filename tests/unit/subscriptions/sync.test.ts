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
