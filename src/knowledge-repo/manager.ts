/**
 * KnowledgeRepoManager (PR 5.5a / design §7.3).
 *
 * Single entry point the API + background cron call into:
 *
 *   subscribe(url):     parse URL, classify host (R-0), clone into
 *                       ~/.helm/repos/<hash>/, persist row
 *   fetchNow(repoId):   ensure clone exists, git fetch, record HEAD,
 *                       return whether anything moved
 *   unsubscribe(id):    flip to 'paused' OR remove the row + clone dir
 *
 * Per-repo lock so two concurrent fetches don't race against the same
 * working tree. Mutations always go through this layer so the
 * lifecycle (clone present / row present / status flip on error)
 * stays consistent.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  deleteKnowledgeRepo,
  getKnowledgeRepo,
  getKnowledgeRepoByUrl,
  insertKnowledgeRepo,
  recordRepoError,
  recordRepoFetch,
  setRepoStatus,
} from '../storage/repos/knowledge-repo.js';
import type { KnowledgeRepo } from '../storage/types.js';
import {
  cloneRepo,
  fetchRepo,
  GitCommandError,
  type GitRunner,
} from './git.js';
import {
  classifyHost,
  parseGitUrl,
} from './url.js';
import { importRepoIntoLibrary, type ImportSummary } from './importer.js';
import type { KnowledgeRepoProfile } from './profiles.js';

export interface KnowledgeRepoManagerOptions {
  db: Database.Database;
  /** System git wrapper. Defaults to createNodeGitRunner() in production. */
  git: GitRunner;
  /**
   * Root for cloned repos. Default `${HELM_HOME ?? ~/.helm}/repos`.
   * Tests inject a tmpdir so clones don't leak between runs.
   */
  reposRoot?: string;
  /** §7.4 R-0: extra hosts to classify as internal. */
  extraInternalHosts?: readonly string[];
}

export interface SubscribeOptions {
  /** Branch from `#branch=...` overrides the URL fragment when set. */
  branch?: string;
  /** Sync cron interval. Default 30 min. */
  syncIntervalMinutes?: number;
  /** When true, fast-forward fetches apply without going through review. */
  autoApply?: boolean;
}

export interface FetchOutcome {
  repoId: string;
  /** True when the branch moved past the last_fetched_sha (or was empty). */
  moved: boolean;
  /** SHA after this fetch. */
  headSha: string;
}

export class KnowledgeRepoManagerError extends Error {
  override readonly name = 'KnowledgeRepoManagerError';
}

export class KnowledgeRepoManager {
  private readonly db: Database.Database;
  private readonly git: GitRunner;
  private readonly reposRoot: string;
  private readonly extraInternalHosts: readonly string[];
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: KnowledgeRepoManagerOptions) {
    this.db = opts.db;
    this.git = opts.git;
    this.reposRoot = opts.reposRoot ?? defaultReposRoot();
    this.extraInternalHosts = opts.extraInternalHosts ?? [];
  }

  async subscribe(url: string, opts: SubscribeOptions = {}): Promise<KnowledgeRepo> {
    const parsed = parseGitUrl(url);
    const existing = getKnowledgeRepoByUrl(this.db, parsed.canonical);
    if (existing) {
      throw new KnowledgeRepoManagerError(
        `already subscribed to ${parsed.canonical} (status=${existing.status})`,
      );
    }
    const branch = opts.branch ?? parsed.branch ?? 'main';
    const classification = classifyHost(parsed.host, {
      extraInternalHosts: this.extraInternalHosts,
    });
    const id = `repo-${randomUUID()}`;
    const localPath = join(this.reposRoot, sha256Short(parsed.canonical));

    mkdirSync(this.reposRoot, { recursive: true });
    try {
      // Fresh clone of the specific branch. depth=1 keeps the disk
      // budget low; the manager re-fetches on a cron when subscribers
      // want updates.
      await cloneRepo(this.git, parsed.canonical, { targetDir: localPath, branch, depth: 1 });
    } catch (err) {
      // Don't leave a half-clone on disk. The fresh clone is cheap to
      // re-do if the user fixes the underlying problem (network/auth).
      safeRemoveDir(localPath);
      throw new KnowledgeRepoManagerError(
        `clone failed: ${(err as Error).message}`,
      );
    }

    const insertParams: Parameters<typeof insertKnowledgeRepo>[1] = {
      id,
      url: parsed.canonical,
      branch,
      localPath,
      classification,
    };
    if (opts.syncIntervalMinutes !== undefined) {
      insertParams.syncIntervalMinutes = opts.syncIntervalMinutes;
    }
    if (opts.autoApply !== undefined) {
      insertParams.autoApply = opts.autoApply;
    }
    insertKnowledgeRepo(this.db, insertParams);
    return getKnowledgeRepo(this.db, id)!;
  }

  async fetchNow(repoId: string): Promise<FetchOutcome> {
    return this.withRepoLock(repoId, async () => {
      const repo = getKnowledgeRepo(this.db, repoId);
      if (!repo) {
        throw new KnowledgeRepoManagerError(`unknown repo: ${repoId}`);
      }
      if (repo.status === 'paused') {
        throw new KnowledgeRepoManagerError(`repo ${repoId} is paused; resume before fetching`);
      }
      if (!existsSync(repo.localPath)) {
        // Lost the clone (e.g. user wiped ~/.helm/repos). Re-clone in
        // place so the next fetch has something to update.
        try {
          await cloneRepo(this.git, repo.url, {
            targetDir: repo.localPath,
            branch: repo.branch, depth: 1,
          });
        } catch (err) {
          recordRepoError(this.db, repoId, `re-clone failed: ${(err as Error).message}`);
          throw err;
        }
      }
      try {
        const result = await fetchRepo(this.git, {
          cwd: repo.localPath, branch: repo.branch,
        });
        recordRepoFetch(this.db, repoId, {
          lastFetchedSha: result.headSha,
          lastFetchedAt: Date.now(),
          status: 'active',
          lastError: null,
        });
        return { repoId, moved: result.moved, headSha: result.headSha };
      } catch (err) {
        const message = err instanceof GitCommandError
          ? err.message
          : (err as Error).message;
        recordRepoError(this.db, repoId, message);
        throw err;
      }
    });
  }

  /**
   * Walk the cloned repo and turn `.md` files into KnowledgePoints.
   * The repo doesn't yet carry a per-row profile column, so the
   * caller passes one — typically defaulting to 'helm-native'. PR
   * 5.5b's mapper handles missing roles/, missing role.yaml, etc.
   * gracefully.
   */
  importNow(repoId: string, profile: KnowledgeRepoProfile = 'helm-native'): ImportSummary {
    const repo = getKnowledgeRepo(this.db, repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${repoId}`);
    }
    return importRepoIntoLibrary({
      db: this.db, localPath: repo.localPath, profile, sourceRef: repoId,
    });
  }

  /**
   * Soft unsubscribe: flip to `paused` and keep the row + clone so
   * resubscribing is cheap. The `removeData` flag is the explicit
   * "really delete it" path that also wipes the clone directory.
   */
  unsubscribe(repoId: string, opts: { removeData?: boolean } = {}): void {
    const repo = getKnowledgeRepo(this.db, repoId);
    if (!repo) return;
    if (!opts.removeData) {
      setRepoStatus(this.db, repoId, 'paused');
      return;
    }
    deleteKnowledgeRepo(this.db, repoId);
    safeRemoveDir(repo.localPath);
  }

  private async withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.locks.get(repoId) as Promise<T> | undefined;
    if (pending) await pending.catch(() => undefined);
    const promise = fn();
    this.locks.set(repoId, promise);
    try {
      return await promise;
    } finally {
      if (this.locks.get(repoId) === promise) this.locks.delete(repoId);
    }
  }
}

function defaultReposRoot(): string {
  const helmHome = process.env['HELM_HOME'] ?? join(homedir(), '.helm');
  return join(helmHome, 'repos');
}

function sha256Short(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function safeRemoveDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch { /* swallow — caller already failed */ }
}
