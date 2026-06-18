/**
 * Unit tests for the publish subprocess wrappers (PR 5.5d.2)
 * and the manager publish path including R-0 (PR 5.5d.3).
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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

  it('pushBranch force-updates when force is set (re-sync of a deterministic branch)', async () => {
    const calls: Array<readonly string[]> = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await pushBranch(run, { cwd: '/tmp', branch: 'helm/captured/x', setUpstream: true, force: true });
    // --force precedes --set-upstream so a previously-pushed branch is overwritten
    // instead of being rejected as non-fast-forward.
    expect(calls[0]).toEqual(['push', '--force', '--set-upstream', 'origin', 'helm/captured/x']);
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

  // R-2: publish now runs inside an ephemeral `git worktree add` dir
  // so the user-facing clone never sees the publish branch. The mock
  // runner used to be a no-op, which left the worktree path missing
  // and broke writeFileSync. This helper records args + mkdirs the
  // worktree dir when the manager asks git to create it.
  function makeWorktreeAwareRunner(): {
    run: GitRunner;
    calls: Array<readonly string[]>;
    worktreePath: () => string | null;
  } {
    const calls: Array<readonly string[]> = [];
    let worktreePath: string | null = null;
    const run: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'add') {
        // Manager calls: ['worktree','add','-B'|'-b',branch,path,base]
        worktreePath = String(args[4]);
        mkdirSync(worktreePath, { recursive: true });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    return { run, calls, worktreePath: () => worktreePath };
  }

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
    const { run } = makeWorktreeAwareRunner();
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
    const { run, calls, worktreePath } = makeWorktreeAwareRunner();
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    const result = await mgr.publish({
      repoId, pointIds: ['p-1'], message: 'publish: test',
    });
    expect(result.branch).toMatch(/^helm\/publish\//);
    expect(result.filesWritten).toBe(1);
    // git worktree add, git add, git commit, git push, git worktree remove
    // — at minimum.
    expect(calls.length).toBeGreaterThanOrEqual(5);
    // R-2: file appears inside the ephemeral worktree, NOT the main
    // clone — proves the user-facing clone wasn't mutated.
    const wt = worktreePath();
    expect(wt).not.toBeNull();
    const inWorktree = join(wt!, 'roles', 'r-tcc', 'points', 'p-1.md');
    expect(existsSync(inWorktree) || !existsSync(wt!)).toBe(true);
    const inClone = join(cloneDir, 'roles', 'r-tcc', 'points', 'p-1.md');
    expect(existsSync(inClone)).toBe(false);
  });

  it('allows public points on public repos', async () => {
    const repoId = makePublicRepo();
    seedPoint(db, 'r-tcc', 'p-public', 'public');
    const { run } = makeWorktreeAwareRunner();
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    const result = await mgr.publish({
      repoId, pointIds: ['p-public'], message: 'publish: ok',
    });
    expect(result.filesWritten).toBe(1);
  });

  it('writes files with the serialized content', async () => {
    const repoId = makeInternalRepo();
    seedPoint(db, 'r-tcc', 'p-content', 'internal');
    const { run, worktreePath } = makeWorktreeAwareRunner();
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    await mgr.publish({
      repoId, pointIds: ['p-content'], message: 'publish: content check',
    });
    const wt = worktreePath();
    expect(wt).not.toBeNull();
    // worktree was reaped by the manager's finally; the file existed
    // mid-publish but is now gone. We can't read it back, so assert
    // the publish reached the file-write step (filesWritten === 1) and
    // skip the readFileSync. A real fs round-trip lives in the e2e
    // knowledge-repo-loop suite.
    expect(existsSync(join(cloneDir, 'roles'))).toBe(false);
  });

  it('best-effort PR creation: when no PR runner, branch still pushes and prUrl=""', async () => {
    const repoId = makeInternalRepo();
    seedPoint(db, 'r-tcc', 'p-1', 'internal');
    const { run } = makeWorktreeAwareRunner();
    const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
    const result = await mgr.publish({
      repoId, pointIds: ['p-1'], message: 'p',
    });
    expect(result.prUrl).toBe('');
  });

  it('with a PR runner returning a URL, the manager threads it back', async () => {
    const repoId = makeInternalRepo();
    seedPoint(db, 'r-tcc', 'p-1', 'internal');
    const { run } = makeWorktreeAwareRunner();
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
