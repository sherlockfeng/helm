import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertRole, bumpRoleVersion } from '../../../src/storage/repos/roles.js';
import {
  getMirror,
  recordPushSuccess,
  upsertMirror,
} from '../../../src/storage/repos/role-mirrors.js';
import { createMirrorRunner } from '../../../src/mirrors/runner.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import type { StoragePlugin } from '../../../src/plugins/types.js';

const NOW = '2026-05-19T00:00:00.000Z';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRoleWithChunk(db: BetterSqlite3.Database, id = 'r1'): void {
  upsertRole(db, { id, name: id, systemPrompt: 'p', isBuiltin: false, createdAt: NOW });
}

/**
 * Minimal storage plugin stub. Captures every upload call so tests can
 * assert what got pushed. `uploadImpl` is optional — defaults to "succeed
 * + return etag-1".
 */
function makeStubPlugin(opts: {
  scheme?: string;
  uploadImpl?: (url: string, data: Buffer) => Promise<{ etag: string }>;
} = {}): { plugin: StoragePlugin; uploads: Array<{ url: string; size: number }> } {
  const uploads: Array<{ url: string; size: number }> = [];
  const plugin: StoragePlugin = {
    id: 'stub-storage',
    scheme: opts.scheme ?? 'tos',
    version: '0.0.0',
    apiVersion: 1,
    init: () => {},
    download: async () => { throw new Error('not implemented'); },
    upload: async (url, data) => {
      uploads.push({ url, size: data.length });
      return opts.uploadImpl ? opts.uploadImpl(url, data) : { etag: 'etag-1' };
    },
    headEtag: async () => null,
    shutdown: async () => {},
  };
  return { plugin, uploads };
}

function makeRegistry(plugin: StoragePlugin): PluginRegistry {
  const reg = new PluginRegistry();
  reg.registerOk(plugin, '<test>');
  return reg;
}

describe('MirrorRunner', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRoleWithChunk(db); });
  afterEach(() => { db.close(); });

  it('pushRole writes recordPushSuccess on plugin upload success', async () => {
    upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
    const { plugin, uploads } = makeStubPlugin();
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 'test',
    });
    runner.start();

    const r = await runner.pushRole('r1');
    expect(r.ok).toBe(true);
    expect(r.pushedVersion).toBe(1);
    expect(r.etag).toBe('etag-1');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toBe('tos://b/helm-role/r1.helmrole');

    const m = getMirror(db, 'r1');
    expect(m?.lastPushedVersion).toBe(1);
    expect(m?.lastPushedEtag).toBe('etag-1');
    expect(m?.lastError).toBeUndefined();

    runner.stop();
  });

  it('pushRole records failure when plugin upload throws', async () => {
    upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
    const { plugin } = makeStubPlugin({
      uploadImpl: async () => { throw new Error('network down'); },
    });
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 'test',
    });
    runner.start();

    const r = await runner.pushRole('r1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('network down');

    const m = getMirror(db, 'r1');
    expect(m?.lastError).toContain('network down');
    expect(m?.lastPushedVersion).toBeUndefined();
    runner.stop();
  });

  it('pushRole returns ok when no mirror exists (race with delete)', async () => {
    const { plugin, uploads } = makeStubPlugin();
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 'test',
    });
    runner.start();
    const r = await runner.pushRole('r1'); // no upsertMirror
    expect(r.ok).toBe(true);
    expect(uploads).toHaveLength(0);
    runner.stop();
  });

  it('triggerSync debounces multiple calls into one push', async () => {
    vi.useFakeTimers();
    upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
    const { plugin, uploads } = makeStubPlugin();
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 'test',
      debounceMs: 1000,
      // Use a huge catch-up interval so the recurring setInterval doesn't
      // become an infinite-timer loop under vi.runAllTimersAsync.
      catchUpIntervalMs: 60 * 60 * 1000,
    });
    runner.start();

    // 3 triggers within the debounce window — only 1 push fires.
    runner.triggerSync('r1');
    await vi.advanceTimersByTimeAsync(300);
    runner.triggerSync('r1');
    await vi.advanceTimersByTimeAsync(300);
    runner.triggerSync('r1');
    expect(uploads).toHaveLength(0);

    // Flush the debounce and let the async upload resolve.
    await vi.advanceTimersByTimeAsync(1000);
    expect(uploads).toHaveLength(1);

    runner.stop();
    vi.useRealTimers();
  });

  it('catch-up sweep pushes mirrors that lag behind role.version', async () => {
    upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
    recordPushSuccess(db, { roleId: 'r1', pushedVersion: 1, at: NOW });
    bumpRoleVersion(db, 'r1'); // role at v=2; mirror at v=1

    const { plugin, uploads } = makeStubPlugin();
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 'test',
    });
    runner.start();

    await runner.runCatchUpSweep();
    expect(uploads).toHaveLength(1);
    expect(getMirror(db, 'r1')?.lastPushedVersion).toBe(2);

    // Second sweep finds nothing — caught up.
    await runner.runCatchUpSweep();
    expect(uploads).toHaveLength(1);

    runner.stop();
  });

  it('records failure when no plugin matches the scheme', async () => {
    upsertMirror(db, { roleId: 'r1', targetUrl: 's3://b', now: NOW });
    const { plugin } = makeStubPlugin({ scheme: 'tos' });
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 'test',
    });
    runner.start();
    const r = await runner.pushRole('r1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no storage plugin loaded for scheme 's3'");
    expect(getMirror(db, 'r1')?.lastError).toContain('s3');
    runner.stop();
  });

  it('skips disabled mirrors', async () => {
    upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', enabled: false, now: NOW });
    const { plugin, uploads } = makeStubPlugin();
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 'test',
    });
    runner.start();
    const r = await runner.pushRole('r1');
    expect(r.ok).toBe(true);
    expect(uploads).toHaveLength(0);
    runner.stop();
  });

  it('manual pushRole clears last_error before retrying', async () => {
    upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
    // First push fails.
    const failing = makeStubPlugin({
      uploadImpl: async () => { throw new Error('first attempt fails'); },
    });
    const reg1 = makeRegistry(failing.plugin);
    const r1 = createMirrorRunner({ db, pluginRegistry: reg1, helmVersion: 't' });
    r1.start();
    await r1.pushRole('r1');
    expect(getMirror(db, 'r1')?.lastError).toContain('first');
    r1.stop();

    // Manual "Push now" with a working plugin should clear the error.
    const succeeding = makeStubPlugin();
    const reg2 = makeRegistry(succeeding.plugin);
    const r2 = createMirrorRunner({ db, pluginRegistry: reg2, helmVersion: 't' });
    r2.start();
    const result = await r2.pushRole('r1');
    expect(result.ok).toBe(true);
    expect(getMirror(db, 'r1')?.lastError).toBeUndefined();
    r2.stop();
  });

  it('stop() unhooks the trigger (subsequent triggerSync is no-op)', async () => {
    vi.useFakeTimers();
    upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
    const { plugin, uploads } = makeStubPlugin();
    const runner = createMirrorRunner({
      db, pluginRegistry: makeRegistry(plugin), helmVersion: 't',
      debounceMs: 100,
      catchUpIntervalMs: 60 * 60 * 1000,
    });
    runner.start();
    runner.stop();
    runner.triggerSync('r1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(uploads).toHaveLength(0);
    vi.useRealTimers();
  });
});
