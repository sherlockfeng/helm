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
  listKnowledgeRepos,
  recordRepoError,
  recordRepoFetch,
  setRepoStatus,
} from '../storage/repos/knowledge-repo.js';
import type { KnowledgeRepo } from '../storage/types.js';
import {
  addWorktree,
  cloneRepo,
  fetchRepo,
  GitCommandError,
  removeWorktree,
  type GitRunner,
} from './git.js';
import {
  classifyHost,
  parseGitUrl,
} from './url.js';
import { importRepoIntoLibrary, type ImportSummary } from './importer.js';
import type { KnowledgeRepoProfile } from './profiles.js';
import {
  serializePoint,
  type SerializerProfile,
} from './serializer.js';
import {
  PublishError,
  addAndCommit,
  createPullRequest,
  pickPlatform,
  pushBranch,
  type CreatePrResult,
  type PrPlatformRunner,
} from './publish.js';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger/index.js';
import { getAliasesForPoint } from '../storage/repos/knowledge-point-alias.js';
import { getOutgoingRels } from '../storage/repos/knowledge-point-rel.js';
import { getChunkById } from '../storage/repos/roles.js';
import type { KnowledgeChunk } from '../storage/types.js';

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
  /**
   * PR 5.5d: gh/glab subprocess runner. When absent, publish() still
   * pushes the branch but the PR-creation step is skipped (returns a
   * PublishResult with prUrl='' so the caller can copy the branch
   * name into the platform manually).
   */
  prRunner?: PrPlatformRunner;
  /**
   * R-21: injected logger for best-effort failure paths (PR creation
   * gives up, worktree cleanup fails). Falls back to console.error
   * when absent so unit tests don't have to wire a logger to get
   * actionable output on stderr.
   */
  logger?: Logger;
}

export interface PublishInput {
  repoId: string;
  /** Points to write out. Must be a non-empty subset of the local DB. */
  pointIds: readonly string[];
  /** New branch name. Defaults to `helm/publish/<repoId>-<yyyymmdd>`. */
  branchName?: string;
  /** Commit + PR message. */
  message: string;
  /** Profile to serialize with. Defaults to 'helm-native'. */
  profile?: SerializerProfile;
  /**
   * Path inside the repo where points live. Defaults to
   * `roles/<roleId>/points/<pointId>.md`. Override when the repo
   * uses a different layout.
   */
  layout?: (chunk: KnowledgeChunk) => string;
  /** Anonymous publisher mode (R-0 for public targets). */
  anonymous?: boolean;
}

export interface PublishResult {
  /** Final branch name pushed. */
  branch: string;
  /** PR / MR URL. Empty when no PR runner is wired. */
  prUrl: string;
  /** Number of .md files written. */
  filesWritten: number;
}

export interface SubscribeOptions {
  /** Branch from `#branch=...` overrides the URL fragment when set. */
  branch?: string;
  /** Sync cron interval. Default 30 min. */
  syncIntervalMinutes?: number;
  /** When true, fast-forward fetches apply without going through review. */
  autoApply?: boolean;
  /** v26 — layout/serialization profile pinned at subscribe time.
   *  Defaults to 'helm-native'. */
  profile?: KnowledgeRepoProfile;
}

export interface SyncSweepOutcome {
  repoId: string;
  fetched: boolean;
  moved: boolean;
  imported: boolean;
  /** pointsUpserted from the auto-apply import, when one ran. */
  importedPoints?: number;
  error?: string;
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
  /**
   * Per-repo FIFO chain. The map value is the tail promise; each new
   * caller chains off it (regardless of fulfilment) and replaces it
   * with their own promise so subsequent callers serialize behind.
   */
  private readonly lockTails = new Map<string, Promise<unknown>>();

  private readonly prRunner?: PrPlatformRunner;
  private readonly logger?: Logger;

  constructor(opts: KnowledgeRepoManagerOptions) {
    this.db = opts.db;
    this.git = opts.git;
    this.reposRoot = opts.reposRoot ?? defaultReposRoot();
    this.extraInternalHosts = opts.extraInternalHosts ?? [];
    if (opts.prRunner) this.prRunner = opts.prRunner;
    if (opts.logger) this.logger = opts.logger;
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
    if (opts.profile !== undefined) {
      insertParams.profile = opts.profile;
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
   * Publish a subset of local KnowledgePoints back to the subscribed
   * repo. The publish flow:
   *   1. R-0 precheck — internal points cannot land on a public repo
   *   2. Checkout a fresh branch in the local clone
   *   3. Write serialized .md files for each point
   *   4. git add + commit + push
   *   5. gh pr create / glab mr create — best-effort, returns URL or ''
   */
  async publish(input: PublishInput): Promise<PublishResult> {
    return this.withRepoLock(input.repoId, async () => {
      const repo = getKnowledgeRepo(this.db, input.repoId);
      if (!repo) {
        throw new PublishError(`unknown repo: ${input.repoId}`, 'precheck');
      }
      if (input.pointIds.length === 0) {
        throw new PublishError('pointIds is empty', 'precheck');
      }

      // R-0 precheck: when the target repo is public, refuse to push
      // any KnowledgePoint marked internal. Anonymous mode does NOT
      // bypass this — anonymizing the author doesn't change the
      // sensitivity of the content.
      if (repo.classification === 'public') {
        const blocked: string[] = [];
        for (const pid of input.pointIds) {
          const chunk = getChunkById(this.db, pid);
          if (chunk?.visibility !== 'public') blocked.push(pid);
        }
        if (blocked.length > 0) {
          throw new PublishError(
            `R-0: ${blocked.length} point(s) marked 'internal' cannot be `
            + `published to a public repo (${repo.url}). Mark them 'public' `
            + `in Library first.`,
            'precheck',
          );
        }
      }

      const branchName = input.branchName ?? defaultBranchName(input.repoId);
      const worktreePath = join(
        this.reposRoot,
        `.publish-${sha256Short(input.repoId)}-${Date.now()}`,
      );

      // Run the whole publish in an ephemeral worktree forked off
      // repo.branch so the user-facing clone never sees the new branch.
      // Without this, the next importNow would read serialized .md
      // files instead of the upstream content.
      await addWorktree(this.git, {
        cwd: repo.localPath,
        worktreePath,
        branch: branchName,
        baseRef: repo.branch,
        force: true,
      });

      let filesWritten = 0;
      let prUrl = '';
      try {
        // v26: explicit profile wins; otherwise the one pinned at
        // subscribe time. 'generic' has no serializer — degrade to
        // helm-native frontmatter.
        const effProfile: SerializerProfile | undefined = input.profile
          ?? (repo.profile === 'llm-wiki' ? 'llm-wiki' : 'helm-native');
        const layout = input.layout
          ?? (effProfile === 'llm-wiki' ? llmWikiLayout : defaultLayout);
        for (const pid of input.pointIds) {
          const chunk = getChunkById(this.db, pid);
          if (!chunk) continue;
          const aliases = getAliasesForPoint(this.db, pid);
          const rel = getOutgoingRels(this.db, pid);
          const text = serializePoint({
            chunk, aliases, rel,
            ...(effProfile ? { profile: effProfile } : {}),
          });
          const absPath = join(worktreePath, layout(chunk));
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, text, 'utf8');
          filesWritten += 1;
        }

        const userOverride = input.anonymous
          ? { name: 'helm-anonymous', email: 'anonymous@helm.local' }
          : undefined;
        await addAndCommit(this.git, worktreePath, input.message, userOverride);
        await pushBranch(this.git, {
          cwd: worktreePath, branch: branchName, setUpstream: true,
        });

        // PR creation is best-effort: when the user hasn't installed gh
        // / glab we still push the branch and let them open the PR by
        // hand. The branch + commit are already on the remote.
        if (this.prRunner) {
          try {
            const platform = pickPlatform(hostFromUrl(repo.url));
            if (platform) {
              const result: CreatePrResult = await createPullRequest(this.prRunner, {
                cwd: worktreePath,
                platform,
                title: firstLineOf(input.message),
                body: bodyAfterFirstLine(input.message),
                baseBranch: repo.branch,
                headBranch: branchName,
              });
              prUrl = result.url;
            }
          } catch (err) {
            // Surface the precise CLI failure but keep the publish as
            // "branch is on the remote". Goes through the injected
            // logger when wired so prod failures land in the renderer
            // log surface; falls back to console.error for tests.
            const msg = (err as Error).message;
            if (this.logger) {
              this.logger.warn('publish_pr_create_failed', {
                data: { repoId: input.repoId, branch: branchName, error: msg },
              });
            } else {
              // eslint-disable-next-line no-console
              console.error(`[helm:publish] PR creation failed: ${msg}`);
            }
          }
        }
      } finally {
        // Always reap the worktree, even on failure. A leaked .publish-*
        // dir would confuse the next subscribe + bloat ~/.helm/repos.
        try {
          await removeWorktree(this.git, repo.localPath, worktreePath);
        } catch {
          // Best-effort: the rmSync below catches anything `git
          // worktree remove` refused to clean up.
        }
        safeRemoveDir(worktreePath);
      }

      return { branch: branchName, prUrl, filesWritten };
    });
  }

  /**
   * Walk the cloned repo and turn `.md` files into KnowledgePoints.
   * The repo doesn't yet carry a per-row profile column, so the
   * caller passes one — typically defaulting to 'helm-native'. PR
   * 5.5b's mapper handles missing roles/, missing role.yaml, etc.
   * gracefully.
   */
  importNow(repoId: string, profile?: KnowledgeRepoProfile): ImportSummary {
    const repo = getKnowledgeRepo(this.db, repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${repoId}`);
    }
    // v26: default to the profile pinned at subscribe time. Explicit
    // arg still wins so callers can do a one-off re-read under a
    // different layout (e.g. debugging a mis-classified repo).
    const effective = profile ?? repo.profile;
    return importRepoIntoLibrary({
      db: this.db, localPath: repo.localPath, profile: effective, sourceRef: repoId,
    });
  }

  /**
   * Scheduled-sync sweep (llm-wiki milestone, pull side). Walks every
   * ACTIVE repo whose `sync_interval_minutes` has elapsed since
   * `last_fetched_at` (or that has never been fetched), fetches it, and
   * — when the branch moved AND the repo opted into `auto_apply` —
   * imports immediately using the pinned profile.
   *
   * Per-repo failures are recorded on the row (recordRepoError inside
   * fetchNow) and reported in the outcome; the sweep continues so one
   * dead remote can't starve the rest.
   */
  async syncDue(now: number = Date.now()): Promise<SyncSweepOutcome[]> {
    const due = listKnowledgeRepos(this.db, { status: 'active' }).filter((r) => {
      if (r.lastFetchedAt == null) return true;
      return r.lastFetchedAt + r.syncIntervalMinutes * 60_000 <= now;
    });

    const outcomes: SyncSweepOutcome[] = [];
    for (const repo of due) {
      const outcome: SyncSweepOutcome = {
        repoId: repo.id, fetched: false, moved: false, imported: false,
      };
      try {
        const fetch = await this.fetchNow(repo.id);
        outcome.fetched = true;
        outcome.moved = fetch.moved;
        if (fetch.moved && repo.autoApply) {
          const summary = this.importNow(repo.id);
          outcome.imported = true;
          outcome.importedPoints = summary.pointsUpserted;
        }
      } catch (err) {
        outcome.error = (err as Error).message;
      }
      outcomes.push(outcome);
    }
    return outcomes;
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

  private withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    // FIFO chain: every caller chains off the previous *tail* — not the
    // current head — so three concurrent callers run strictly in
    // arrival order (A → B → C), each waiting on its predecessor's
    // settlement (success OR failure).
    const previousTail = this.lockTails.get(repoId);
    const myTask: Promise<T> = (previousTail
      ? previousTail.then(() => fn(), () => fn())
      : fn());
    // Store the swallowed-error tail so subsequent enqueues don't
    // reject the chain just because we did.
    const newTail = myTask.then(() => undefined, () => undefined);
    this.lockTails.set(repoId, newTail);
    void newTail.then(() => {
      // Only clear the slot if we're still the tail; otherwise a later
      // caller has taken over already.
      if (this.lockTails.get(repoId) === newTail) {
        this.lockTails.delete(repoId);
      }
    });
    return myTask;
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

function defaultBranchName(repoId: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `helm/publish/${repoId.slice(0, 12)}-${date}`;
}

function defaultLayout(chunk: KnowledgeChunk): string {
  // Mirror the importer's expected layout so a publish-then-import
  // round-trip lands the points in the same files.
  return `roles/${chunk.roleId}/points/${chunk.id}.md`;
}

function llmWikiLayout(chunk: KnowledgeChunk): string {
  // llm-wiki convention: top-level dirs ARE the roles (dr-docs/,
  // doc-lsp-docs/, …), .md files directly inside.
  //
  // A sourceFile containing a path separator is treated as a
  // repo-relative origin (republish lands back in the same file).
  // The separator guard matters: trainRole-born chunks carry FLAT
  // doc filenames ("chat-48910a39-turn-3.md") that are NOT repo
  // paths — without the check they'd publish to the repo root.
  if (chunk.sourceFile && chunk.sourceFile.includes('/') && chunk.sourceFile.endsWith('.md')) {
    return chunk.sourceFile;
  }
  return `${chunk.roleId}/${chunk.id}.md`;
}

function hostFromUrl(url: string): string {
  // Mirror parseGitUrl's host extraction without re-parsing the whole
  // URL — we already trust the row's canonical url.
  const ssh = url.match(/^[^@]+@([^:]+):/);
  if (ssh) return ssh[1]!.toLowerCase();
  try { return new URL(url.replace(/^git\+/, '')).hostname.toLowerCase(); }
  catch { return ''; }
}

function firstLineOf(message: string): string {
  return message.split('\n', 1)[0]!.trim();
}

function bodyAfterFirstLine(message: string): string {
  const idx = message.indexOf('\n');
  return idx < 0 ? '' : message.slice(idx + 1).trim();
}
