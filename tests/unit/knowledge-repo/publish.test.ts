/**
 * Unit tests for the publish subprocess wrappers (PR 5.5d.2)
 * and the manager publish path including R-0 (PR 5.5d.3).
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { KnowledgeRepoManager } from '../../../src/knowledge-repo/manager.js';
import {
  PublishError,
  checkoutBranch,
  pickPlatform,
  pushBranch,
} from '../../../src/knowledge-repo/publish.js';
import type { GitRunner } from '../../../src/knowledge-repo/git.js';
import type { PrPlatformRunner } from '../../../src/knowledge-repo/publish.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedPoint(
  db: BetterSqlite3.Database,
  roleId: string, pointId: string,
  visibility: 'internal' | 'public' = 'internal',
): void {
  upsertRole(db, {
    id: roleId, name: roleId, systemPrompt: '',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  db.prepare(`
    INSERT INTO knowledge_chunks
      (id, role_id, chunk_text, kind, visibility, created_at)
    VALUES (?, ?, 'body', 'spec', ?, ?)
  `).run(pointId, roleId, visibility, new Date().toISOString());
}

describe('checkoutBranch / pushBranch wrappers', () => {
  it('builds the right argv for a fresh checkout (-b)', async () => {
    const calls: Array<readonly string[]> = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await checkoutBranch(run, { cwd: '/tmp', branch: 'helm/publish/x' });
    expect(calls[0]).toEqual(['checkout', '-b', 'helm/publish/x']);
  });

  it('uses -B when force is true', async () => {
    const calls: Array<readonly string[]> = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await checkoutBranch(run, { cwd: '/tmp', branch: 'x', force: true });
    expect(calls[0]).toEqual(['checkout', '-B', 'x']);
  });

  it('checkoutBranch throws PublishError with stage="branch" on git failure', async () => {
    const run: GitRunner = async () => ({ stdout: '', stderr: 'bad', exitCode: 128 });
    try { await checkoutBranch(run, { cwd: '/tmp', branch: 'x' }); expect.fail('expected'); }
    catch (err) {
      expect(err).toBeInstanceOf(PublishError);
      expect((err as PublishError).stage).toBe('branch');
    }
  });

  it('pushBranch sets --set-upstream when requested', async () => {
    const calls: Array<readonly string[]> = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await pushBranch(run, { cwd: '/tmp', branch: 'x', setUpstream: true });
    expect(calls[0]).toEqual(['push', '--set-upstream', 'origin', 'x']);
  });
});

describe('pickPlatform', () => {
  it('maps github.com → github', () => {
    expect(pickPlatform('github.com')).toBe('github');
  });
  it('maps gitlab.* hosts → gitlab', () => {
    expect(pickPlatform('gitlab.com')).toBe('gitlab');
    expect(pickPlatform('gitlab.acme.internal')).toBe('gitlab');
  });
  it('maps internal byted hosts → gitlab', () => {
    expect(pickPlatform('code.byted.org')).toBe('gitlab');
  });
  it('returns null for unknown hosts', () => {
    expect(pickPlatform('example.com')).toBeNull();
  });
});

describe('KnowledgeRepoManager.publish (R-0)', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;
  let cloneDir: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-pub-'));
    cloneDir = join(reposRoot, 'clone');
    mkdirSync(cloneDir, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  function makePublicRepo(): string {
    const repoId = 'repo-public';
    db.prepare(`
      INSERT INTO knowledge_repo
        (id, url, branch, local_path, classification, status,
         sync_interval_minutes, auto_apply, created_at, updated_at)
      VALUES (?, 'https://github.com/team/x', 'main', ?, 'public', 'active',
        30, 0, ?, ?)
    `).run(repoId, cloneDir, Date.now(), Date.now());
    return repoId;
  }

  function makeInternalRepo(): string {
    const repoId = 'repo-internal';
    db.prepare(`
      INSERT INTO knowledge_repo
        (id, url, branch, local_path, classification, status,
         sync_interval_minutes, auto_apply, created_at, updated_at)
      VALUES (?, 'https://code.byted.org/team/x', 'main', ?, 'internal', 'active',
        30, 0, ?, ?)
    `).run(repoId, cloneDir, Date.now(), Date.now());
    return repoId;
  }

  it('R-0: refuses to publish internal points to a public repo with stage=precheck', async () => {
    const repoId = makePublicRepo();
    seedPoint(db, 'r-tcc', 'p-internal', 'internal');
    const run: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    try {
      await mgr.publish({
        repoId, pointIds: ['p-internal'], message: 'publish: test',
      });
      expect.fail('expected R-0 block');
    } catch (err) {
      expect(err).toBeInstanceOf(PublishError);
      const e = err as PublishError;
      expect(e.stage).toBe('precheck');
      expect(e.message).toMatch(/R-0/);
    }
  });

  it('allows internal points to internal repos', async () => {
    const repoId = makeInternalRepo();
    seedPoint(db, 'r-tcc', 'p-1', 'internal');
    const calls: Array<readonly string[]> = [];
    const run: GitRunner = async (args) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0 }; };
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    const result = await mgr.publish({
      repoId, pointIds: ['p-1'], message: 'publish: test',
    });
    expect(result.branch).toMatch(/^helm\/publish\//);
    expect(result.filesWritten).toBe(1);
    // git checkout, git add, git commit, git push — at minimum.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // File appeared on disk under roles/<roleId>/points/<pointId>.md
    const expected = join(cloneDir, 'roles', 'r-tcc', 'points', 'p-1.md');
    expect(existsSync(expected)).toBe(true);
  });

  it('allows public points on public repos', async () => {
    const repoId = makePublicRepo();
    seedPoint(db, 'r-tcc', 'p-public', 'public');
    const run: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    const result = await mgr.publish({
      repoId, pointIds: ['p-public'], message: 'publish: ok',
    });
    expect(result.filesWritten).toBe(1);
  });

  it('writes files with the serialized content', async () => {
    const repoId = makeInternalRepo();
    seedPoint(db, 'r-tcc', 'p-content', 'internal');
    const run: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    await mgr.publish({
      repoId, pointIds: ['p-content'], message: 'publish: content check',
    });
    const text = readFileSync(
      join(cloneDir, 'roles', 'r-tcc', 'points', 'p-content.md'),
      'utf8',
    );
    expect(text).toContain('id: p-content');
    expect(text).toContain('body'); // chunk_text content
  });

  it('best-effort PR creation: when no PR runner, branch still pushes and prUrl=""', async () => {
    const repoId = makeInternalRepo();
    seedPoint(db, 'r-tcc', 'p-1', 'internal');
    const run: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    const result = await mgr.publish({
      repoId, pointIds: ['p-1'], message: 'p',
    });
    expect(result.prUrl).toBe('');
  });

  it('with a PR runner returning a URL, the manager threads it back', async () => {
    const repoId = makeInternalRepo();
    seedPoint(db, 'r-tcc', 'p-1', 'internal');
    const run: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const prRunner: PrPlatformRunner = async () => ({
      stdout: 'https://code.byted.org/team/x/merge_requests/42\n',
      stderr: '', exitCode: 0,
    });
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot, prRunner });
    const result = await mgr.publish({
      repoId, pointIds: ['p-1'], message: 'p',
    });
    expect(result.prUrl).toBe('https://code.byted.org/team/x/merge_requests/42');
  });
});
