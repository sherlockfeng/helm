/**
 * E2e — knowledge-repo loop (R-12).
 *
 * Boots a real `git init --bare` remote in a temp dir, drives the real
 * KnowledgeRepoManager (with the real GitRunner backed by the system
 * `git` binary) through subscribe → publish → fetch → import. No
 * mocked git anywhere: this catches the class of regression where the
 * subprocess wrapper, the worktree dance, or the importer interact
 * subtly with real git plumbing.
 *
 * Skipped automatically when `git` is missing from PATH so the suite
 * still runs cleanly on minimal CI images.
 */

import BetterSqlite3 from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { KnowledgeRepoManager } from '../../../src/knowledge-repo/manager.js';
import { createNodeGitRunner } from '../../../src/knowledge-repo/git-runner.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

function gitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const SKIP = !gitAvailable();
const describeOrSkip = SKIP ? describe.skip : describe;

function makeBareRemote(root: string): string {
  const bareDir = join(root, 'remote.git');
  execSync(`git init --bare --initial-branch=main "${bareDir}"`, { stdio: 'ignore' });
  // git init --bare doesn't create an initial commit; seed one via a
  // throwaway clone so the manager's first subscribe finds a HEAD.
  const seedDir = join(root, '_seed');
  execSync(`git clone "${bareDir}" "${seedDir}"`, { stdio: 'ignore' });
  execSync(`git -C "${seedDir}" config user.email "seed@helm.local"`);
  execSync(`git -C "${seedDir}" config user.name "seed"`);
  writeFileSync(join(seedDir, 'README.md'), '# seed\n');
  execSync(`git -C "${seedDir}" add README.md`);
  execSync(`git -C "${seedDir}" commit -m "seed"`, { stdio: 'ignore' });
  execSync(`git -C "${seedDir}" push origin main`, { stdio: 'ignore' });
  rmSync(seedDir, { recursive: true, force: true });
  return bareDir;
}

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedPublishablePoint(
  db: BetterSqlite3.Database,
  pointId: string,
  body = 'publishable body',
): void {
  upsertRole(db, {
    id: 'r-loop', name: 'Loop role', systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  db.prepare(`
    INSERT INTO knowledge_chunks
      (id, role_id, chunk_text, kind, created_at, visibility, edit_version)
    VALUES (?, 'r-loop', ?, 'spec', ?, 'public', 1)
  `).run(pointId, body, new Date().toISOString());
}

describeOrSkip('e2e knowledge-repo loop (R-12)', () => {
  let root: string;
  let remoteUrl: string;
  let db: BetterSqlite3.Database;
  let mgr: KnowledgeRepoManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'helm-repo-loop-'));
    const bareDir = makeBareRemote(root);
    remoteUrl = `file://${bareDir}`;
    db = openDb();
    // Force the system git's commit-author identity inline so the test
    // host doesn't need a real user.email / user.name config.
    const env = {
      GIT_AUTHOR_NAME: 'helm-test', GIT_AUTHOR_EMAIL: 'test@helm.local',
      GIT_COMMITTER_NAME: 'helm-test', GIT_COMMITTER_EMAIL: 'test@helm.local',
    };
    mgr = new KnowledgeRepoManager({
      db,
      git: createNodeGitRunner({ env }),
      reposRoot: join(root, 'clones'),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('subscribe → publish → fetch round-trip lands the new commit on the remote', async () => {
    const repo = await mgr.subscribe(remoteUrl, { branch: 'main' });
    expect(repo.status).toBe('active');
    expect(repo.lastFetchedSha ?? '').toMatch(/^[0-9a-f]+$/i);

    seedPublishablePoint(db, 'p-loop-1', 'first published body');

    const before = repo.lastFetchedSha;
    const publishResult = await mgr.publish({
      repoId: repo.id,
      pointIds: ['p-loop-1'],
      message: 'publish first point\n\nbody from helm',
    });
    expect(publishResult.filesWritten).toBe(1);
    expect(publishResult.branch).toMatch(/^helm\/publish\//);

    // A second clone of the bare remote should see the publish branch
    // — proves the push actually landed, not just the local commit.
    const verifyDir = mkdtempSync(join(root, 'verify-'));
    execSync(`git clone --quiet "${remoteUrl}" "${verifyDir}"`);
    const branches = execSync(`git -C "${verifyDir}" ls-remote --heads origin`)
      .toString();
    expect(branches).toContain(publishResult.branch);

    // The original clone should NOT be sitting on the publish branch —
    // R-2's worktree isolation keeps the user-facing clone on main.
    const ourClone = repo.localPath;
    const ourBranch = execSync(`git -C "${ourClone}" rev-parse --abbrev-ref HEAD`)
      .toString().trim();
    expect(ourBranch).toBe('main');
    expect(before).toBeDefined();
  });

  it('attack: two concurrent publishes against the same repo serialize via the FIFO lock', async () => {
    const repo = await mgr.subscribe(remoteUrl, { branch: 'main' });
    seedPublishablePoint(db, 'p-a', 'A body');
    seedPublishablePoint(db, 'p-b', 'B body');

    // Without the FIFO lock, the worktree paths use timestamp-based
    // names that could collide. With the lock, the second publish
    // waits for the first to finish.
    const [a, b] = await Promise.all([
      mgr.publish({
        repoId: repo.id, pointIds: ['p-a'],
        message: 'concurrent A', branchName: 'helm/publish/concurrent-a',
      }),
      mgr.publish({
        repoId: repo.id, pointIds: ['p-b'],
        message: 'concurrent B', branchName: 'helm/publish/concurrent-b',
      }),
    ]);
    expect(a.filesWritten).toBe(1);
    expect(b.filesWritten).toBe(1);

    const verifyDir = mkdtempSync(join(root, 'verify-attack-'));
    execSync(`git clone --quiet "${remoteUrl}" "${verifyDir}"`);
    const branches = execSync(`git -C "${verifyDir}" ls-remote --heads origin`).toString();
    expect(branches).toContain('helm/publish/concurrent-a');
    expect(branches).toContain('helm/publish/concurrent-b');
  }, 30_000);

  it('R-13 closed-loop: publish from one DB, import into a fresh DB via subscribe → import', async () => {
    // First DB publishes a point.
    const repo = await mgr.subscribe(remoteUrl, { branch: 'main' });
    seedPublishablePoint(db, 'p-shared', 'shared knowledge body');
    // Drop a role.yaml so the importer can attach the imported chunk
    // to the right role on the receiving side.
    const layout = (): string => 'roles/r-loop/points/p-shared.md';
    // The default branch (main) is what the second DB clones; force the
    // publish onto main by piggybacking on a fresh worktree branch and
    // then fast-forwarding main on the bare remote.
    const pub = await mgr.publish({
      repoId: repo.id,
      pointIds: ['p-shared'],
      message: 'closed-loop seed',
      layout,
    });
    // Fast-forward main on the bare remote to the publish branch so
    // the second DB sees the new content on its default clone.
    execSync(`git -C "${repo.localPath}" fetch origin ${pub.branch}`);
    const ffDir = mkdtempSync(join(root, 'ff-'));
    execSync(`git clone "${remoteUrl}" "${ffDir}"`);
    execSync(`git -C "${ffDir}" fetch origin ${pub.branch}`);
    execSync(`git -C "${ffDir}" merge --ff-only FETCH_HEAD`);
    // Add the role.yaml the importer expects.
    mkdirSync(join(ffDir, 'roles', 'r-loop'), { recursive: true });
    writeFileSync(
      join(ffDir, 'roles', 'r-loop', 'role.yaml'),
      'id: r-loop\nname: Loop role\n',
    );
    execSync(`git -C "${ffDir}" add -A`);
    execSync(`git -C "${ffDir}" -c user.email=t@x -c user.name=t commit -m "add role.yaml"`);
    execSync(`git -C "${ffDir}" push origin main`);

    // Fresh DB + fresh manager — never saw the original publish.
    const db2 = openDb();
    const mgr2 = new KnowledgeRepoManager({
      db: db2, git: createNodeGitRunner(),
      reposRoot: join(root, 'clones-2'),
    });
    const repo2 = await mgr2.subscribe(remoteUrl, { branch: 'main' });
    const summary = mgr2.importNow(repo2.id);
    expect(summary.pointsUpserted).toBeGreaterThan(0);
    const imported = db2.prepare(
      `SELECT chunk_text FROM knowledge_chunks WHERE id = 'p-shared'`,
    ).get() as { chunk_text: string } | undefined;
    expect(imported?.chunk_text).toContain('shared knowledge body');
    db2.close();
  }, 30_000);

  it('attack: publishing an internal point to a public remote is refused (R-0)', async () => {
    // Force the manager to classify the file:// URL as public so the
    // R-0 gate fires. Real internal hosts are byted-only by default.
    const publicMgr = new KnowledgeRepoManager({
      db,
      git: createNodeGitRunner({
        env: {
          GIT_AUTHOR_NAME: 'helm-test', GIT_AUTHOR_EMAIL: 'test@helm.local',
          GIT_COMMITTER_NAME: 'helm-test', GIT_COMMITTER_EMAIL: 'test@helm.local',
        },
      }),
      reposRoot: join(root, 'clones-r0'),
    });
    const repo = await publicMgr.subscribe(remoteUrl, { branch: 'main' });
    expect(repo.classification).toBe('public');

    // Insert an internal point — must NOT publish to a public repo.
    upsertRole(db, {
      id: 'r-r0', name: 'r-r0', systemPrompt: 'sp',
      isBuiltin: false, createdAt: new Date().toISOString(),
    });
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, role_id, chunk_text, kind, created_at, visibility, edit_version)
      VALUES ('p-internal', 'r-r0', 'sensitive', 'spec', ?, 'internal', 1)
    `).run(new Date().toISOString());

    await expect(publicMgr.publish({
      repoId: repo.id, pointIds: ['p-internal'], message: 'should be blocked',
    })).rejects.toThrowError(/R-0/);
  });
});
