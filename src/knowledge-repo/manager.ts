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
  listChangedFiles,
  mergeFfOnly,
  removeWorktree,
  showFileAtRef,
  statusPorcelain,
  type GitRunner,
} from './git.js';
import {
  classifyHost,
  parseGitUrl,
} from './url.js';
import { LLM_WIKI_SKIP_DIRS, importRepoIntoLibrary, type ImportSummary } from './importer.js';
import { slugifyPointId } from './slug.js';
import type { KnowledgeRepoProfile } from './profiles.js';
import {
  serializePoint,
  type SerializerProfile,
} from './serializer.js';
import { serializeCase } from './case-file.js';
import { getCase } from '../storage/repos/benchmark.js';
import {
  PublishError,
  addAndCommit,
  createPullRequest,
  pickPlatform,
  pushBranch,
  type CreatePrResult,
  type PrPlatformRunner,
} from './publish.js';
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  /** Points to write out. May be empty when `extraFiles` is provided. */
  pointIds: readonly string[];
  /**
   * PR-γ: literal files to include in the publish commit alongside (or
   * instead of) serialized points — e.g. a consolidated promotion doc
   * for domains/<域>/. Paths are repo-root-relative.
   */
  extraFiles?: ReadonlyArray<{ relPath: string; content: string }>;
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
  /** PR-3: true when the working tree was fast-forwarded to the new SHA. */
  treeSynced?: boolean;
  /** PR-3: untracked-vs-incoming collisions resolved before the merge. */
  collisions?: CapturedCollision[];
}

/**
 * PR-3: an untracked local file (typically a captured point) that an
 * incoming merge would have overwritten, and how it was cleared.
 */
export interface CapturedCollision {
  relPath: string;
  /**
   * 'removed_identical' — local bytes matched the incoming tracked
   * version (the usual case: our own MR merged), so the untracked copy
   * was simply deleted.
   * 'backed_up' — content diverged; local copy moved to
   * .helm-backup/<relPath> (hidden dir — invisible to the importer)
   * and the reviewed upstream version wins in the working tree.
   */
  action: 'removed_identical' | 'backed_up';
}

/** PR-3: a captured file in the working copy not yet on the remote. */
export interface UnpublishedCaptured {
  relPath: string;
  /** '??' = new (never published), otherwise modified since last publish. */
  isNew: boolean;
  /** Chunk whose source_file points at this path, when indexed. */
  pointId?: string;
  title?: string;
  /** A benchmark-case file under cases/ — publishable as a literal file
   *  (no knowledge-chunk pointId), NOT an "un-indexed, will skip" point. */
  isCase?: boolean;
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
        const outcome: FetchOutcome = {
          repoId, moved: result.moved, headSha: result.headSha,
        };
        // PR-3: a fetch alone never changed what importNow reads — the
        // working tree stayed at clone-time state. Fast-forward it to
        // the fetched SHA so files-as-truth holds ("the working copy IS
        // the source of truth"). Untracked captured files that the
        // merge would overwrite are cleared first (git refuses
        // otherwise): identical content is just deleted, divergent
        // content is parked under .helm-backup/.
        if (result.moved) {
          try {
            outcome.collisions = await this.clearMergeCollisions(repo);
            await mergeFfOnly(this.git, repo.localPath, `origin/${repo.branch}`);
            outcome.treeSynced = true;
          } catch (err) {
            // Leave the tree as-is; the fetch itself succeeded, so keep
            // status 'active' (the index still serves) but surface the
            // problem on the row for the UI.
            const message = `working-tree sync failed: ${(err as Error).message}`;
            recordRepoFetch(this.db, repoId, {
              lastFetchedSha: result.headSha,
              lastFetchedAt: Date.now(),
              status: 'active',
              lastError: message,
            });
            this.logger?.warn('knowledge_repo_tree_sync_failed', {
              data: { repoId, message },
            });
            outcome.treeSynced = false;
          }
        }
        return outcome;
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
      if (input.pointIds.length === 0 && (input.extraFiles?.length ?? 0) === 0) {
        throw new PublishError('nothing to publish: no pointIds and no extraFiles', 'precheck');
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
        for (const f of input.extraFiles ?? []) {
          const absPath = join(worktreePath, f.relPath);
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, f.content, 'utf8');
          filesWritten += 1;
        }

        const userOverride = input.anonymous
          ? { name: 'helm-anonymous', email: 'anonymous@helm.local' }
          : undefined;
        await addAndCommit(this.git, worktreePath, input.message, userOverride);
        // Force: the branch is regenerated from base in this worktree, and the
        // captured-publish branch name is deterministic (date + point-set hash),
        // so a re-sync after a failed/partial attempt must overwrite the prior
        // remote branch instead of being rejected as non-fast-forward.
        await pushBranch(this.git, {
          cwd: worktreePath, branch: branchName, setUpstream: true, force: true,
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
      ...(repo.importDirs && repo.importDirs.length > 0
        ? { importDirs: repo.importDirs } : {}),
    });
  }

  /**
   * PR-3: clear untracked files that the upcoming ff merge would
   * overwrite. Runs inside fetchNow's repo lock. Returns what was
   * cleared and how (see CapturedCollision).
   */
  private async clearMergeCollisions(repo: KnowledgeRepo): Promise<CapturedCollision[]> {
    const remoteRef = `origin/${repo.branch}`;
    const incoming = await listChangedFiles(this.git, repo.localPath, 'HEAD', remoteRef);
    if (incoming.length === 0) return [];
    const untracked = new Set(
      (await statusPorcelain(this.git, repo.localPath))
        .filter((e) => e.status === '??')
        .map((e) => e.path),
    );
    const collisions: CapturedCollision[] = [];
    for (const relPath of incoming) {
      if (!untracked.has(relPath)) continue;
      const absPath = join(repo.localPath, relPath);
      let local: string | null = null;
      try { local = readFileSync(absPath, 'utf8'); } catch { continue; }
      const remote = await showFileAtRef(this.git, repo.localPath, remoteRef, relPath);
      if (remote !== null && remote === local) {
        // Typical loop closure: our captured file's MR merged upstream;
        // the tracked version takes over byte-for-byte.
        rmSync(absPath);
        collisions.push({ relPath, action: 'removed_identical' });
      } else {
        // Diverged (e.g. edited during MR review). The reviewed
        // upstream version wins; park the local copy where the
        // importer can't see it (hidden dir) for manual salvage.
        const backupAbs = join(repo.localPath, '.helm-backup', relPath);
        mkdirSync(dirname(backupAbs), { recursive: true });
        renameSync(absPath, backupAbs);
        collisions.push({ relPath, action: 'backed_up' });
      }
    }
    return collisions;
  }

  /**
   * PR-3: captured files in the working copy that the remote doesn't
   * have yet — the "N 条已沉淀未发布" feed. Untracked = never
   * published; tracked-but-modified = changed since the last publish.
   * Read-only (git status + DB lookups), so no repo lock.
   */
  async listUnpublishedCaptured(repoId: string): Promise<UnpublishedCaptured[]> {
    const repo = getKnowledgeRepo(this.db, repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${repoId}`);
    }
    if (!existsSync(repo.localPath)) return [];
    const entries = await statusPorcelain(this.git, repo.localPath, 'chat-captured');
    const out: UnpublishedCaptured[] = [];
    for (const e of entries) {
      if (!e.path.endsWith('.md')) continue;
      const item: UnpublishedCaptured = {
        relPath: e.path,
        isNew: e.status === '??',
      };
      // Benchmark-case files live under chat-captured/<user>/<role>/cases/.
      // They're not knowledge chunks (no source_file row) but ARE publishable
      // files-as-truth — flag them so publishCaptured ships them via
      // extraFiles instead of skipping them as "un-indexed".
      if (e.path.includes('/cases/')) {
        item.isCase = true;
        item.title = e.path.split('/').pop()?.replace(/\.md$/, '');
        out.push(item);
        continue;
      }
      const row = this.db.prepare(
        `SELECT id, chunk_text FROM knowledge_chunks WHERE source_file = ?`,
      ).get(e.path) as { id: string; chunk_text: string } | undefined;
      if (row) {
        item.pointId = row.id;
        const firstLine = row.chunk_text.split('\n')
          .find((l) => l.trim().length > 0);
        if (firstLine) item.title = firstLine.replace(/^#+\s*/, '').trim();
      }
      out.push(item);
    }
    return out;
  }

  /**
   * PR-3: batch-publish every unpublished captured point as one MR.
   * Thin orchestration over publish() — which serializes from the DB
   * and (via llmWikiLayout + source_file) writes each point to the
   * exact path its captured file already occupies, inside an ephemeral
   * worktree. Files without an indexed chunk are skipped and reported.
   *
   * No own lock: publish() acquires the repo lock itself, and taking
   * it here first would deadlock the FIFO chain.
   */
  async publishCaptured(input: {
    repoId: string;
    message?: string;
    anonymous?: boolean;
  }): Promise<PublishResult & { pointIds: string[]; skipped: string[] }> {
    const repo = getKnowledgeRepo(this.db, input.repoId);
    if (!repo) throw new KnowledgeRepoManagerError(`unknown repo: ${input.repoId}`);
    const unpublished = await this.listUnpublishedCaptured(input.repoId);
    const pointIds = unpublished
      .map((u) => u.pointId)
      .filter((id): id is string => typeof id === 'string');
    // Benchmark-case files ride the same MR as literal extraFiles (no DB
    // pointId — their content comes straight off the working copy).
    const caseEntries = unpublished.filter((u) => u.isCase);
    const extraFiles: Array<{ relPath: string; content: string }> = [];
    for (const c of caseEntries) {
      try {
        extraFiles.push({ relPath: c.relPath, content: readFileSync(join(repo.localPath, c.relPath), 'utf8') });
      } catch { /* file vanished — skip silently */ }
    }
    // Genuinely un-indexed = no pointId AND not a case file.
    const skipped = unpublished
      .filter((u) => !u.pointId && !u.isCase)
      .map((u) => u.relPath);
    if (pointIds.length === 0 && extraFiles.length === 0) {
      throw new KnowledgeRepoManagerError(
        'no unpublished captured points (nothing indexed under chat-captured/)',
      );
    }
    const total = pointIds.length + extraFiles.length;
    const message = input.message ?? [
      `feat(chat-captured): publish ${total} captured file(s)`,
      '',
      ...unpublished.filter((u) => u.pointId || u.isCase).map((u) => `- ${u.relPath}`),
    ].join('\n');
    const seed = (pointIds.length > 0 ? pointIds.join(',') : extraFiles.map((f) => f.relPath).join(','));
    const result = await this.publish({
      repoId: input.repoId,
      pointIds,
      ...(extraFiles.length > 0 ? { extraFiles } : {}),
      message,
      branchName: `helm/captured/${new Date().toISOString().slice(0, 10)}-${sha256Short(seed).slice(0, 6)}`,
      ...(input.anonymous !== undefined ? { anonymous: input.anonymous } : {}),
    });
    if (skipped.length > 0) {
      this.logger?.warn('publish_captured_skipped_unindexed', {
        data: { repoId: input.repoId, skipped },
      });
    }
    return { ...result, pointIds, skipped };
  }

  /**
   * 知识阶梯 PR-γ: 升格 — push a consolidated personal-knowledge doc
   * into the team tier (domains/<域>/) as an MR. The user picks
   * fragments in the UI, edits the merged body, and helm opens one MR;
   * after review + merge + pull the content comes back as team
   * knowledge. Personal fragments are NOT auto-deleted — the MR may be
   * rejected; cleanup is a manual follow-up once it lands.
   */
  async promoteToDomain(input: {
    repoId: string;
    /** Target sub-domain under domains/, e.g. 'stability'. */
    domain: string;
    title: string;
    /** Consolidated markdown body (user-edited in the modal). */
    body: string;
    /** Anonymous publisher mode (passes through to publish). */
    anonymous?: boolean;
  }): Promise<PublishResult & { relPath: string }> {
    const repo = getKnowledgeRepo(this.db, input.repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${input.repoId}`);
    }
    if (repo.profile !== 'llm-wiki') {
      throw new KnowledgeRepoManagerError(
        `promoteToDomain requires an llm-wiki repo (got profile=${repo.profile})`,
      );
    }
    const domain = sanitizePathSegment(input.domain);
    const title = input.title.trim();
    const body = input.body.trim();
    if (!domain || !title || !body) {
      throw new KnowledgeRepoManagerError('promoteToDomain requires domain + title + body');
    }
    const slug = slugifyPointId(title, `promoted-${sha256Short(title + body).slice(0, 8)}`);
    const relPath = `domains/${domain}/${slug}.md`;
    const content = `# ${title}\n\n${body}\n`;
    const date = new Date().toISOString().slice(0, 10);
    const result = await this.publish({
      repoId: input.repoId,
      pointIds: [],
      extraFiles: [{ relPath, content }],
      message: [
        `feat(${domain}): promote chat-captured knowledge — ${title}`,
        '',
        `个人层碎片整理升格；来源 chat-captured（helm 知识阶梯）。`,
      ].join('\n'),
      branchName: `helm/promote/${domain}-${date}-${slug.slice(0, 24)}`,
      ...(input.anonymous !== undefined ? { anonymous: input.anonymous } : {}),
    });
    return { ...result, relPath };
  }

  /**
   * Files-as-truth PR-2: write a promoted chunk into helm's exclusive
   * zone of the llm-wiki working copy —
   * `chat-captured/<user>/<role>/<chunkId>.md` — and point the chunk's
   * source_file at it. The file is untracked until PR-3's batch-MR
   * publish; the local working copy IS the source of truth, so the
   * write is what makes the promotion durable.
   *
   * Runs under the repo lock so it can't interleave with a concurrent
   * fetch/import touching the same working copy.
   */
  async writeCapturedPoint(input: {
    repoId: string;
    chunkId: string;
    /** Settings-provided wiki username — the <user> path segment. */
    username: string;
  }): Promise<{ relPath: string; absPath: string }> {
    const repo = getKnowledgeRepo(this.db, input.repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${input.repoId}`);
    }
    if (repo.profile !== 'llm-wiki') {
      throw new KnowledgeRepoManagerError(
        `writeCapturedPoint requires an llm-wiki repo (got profile=${repo.profile})`,
      );
    }
    const chunk = getChunkById(this.db, input.chunkId);
    if (!chunk) {
      throw new KnowledgeRepoManagerError(`unknown chunk: ${input.chunkId}`);
    }
    const user = sanitizePathSegment(input.username);
    const role = sanitizePathSegment(chunk.roleId);
    const file = sanitizePathSegment(chunk.id);
    if (!user || !role || !file) {
      throw new KnowledgeRepoManagerError(
        `cannot build a chat-captured path from username=${JSON.stringify(input.username)} roleId=${JSON.stringify(chunk.roleId)} chunkId=${JSON.stringify(chunk.id)}`,
      );
    }
    const relPath = `chat-captured/${user}/${role}/${file}.md`;
    return this.withRepoLock(input.repoId, async () => {
      const text = serializePoint({
        chunk,
        aliases: getAliasesForPoint(this.db, chunk.id),
        rel: getOutgoingRels(this.db, chunk.id),
        profile: 'llm-wiki',
      });
      const absPath = join(repo.localPath, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, text, 'utf8');
      // Same column the importer maintains — publish (llmWikiLayout)
      // round-trips into this exact file from now on.
      this.db.prepare(`UPDATE knowledge_chunks SET source_file = ? WHERE id = ?`)
        .run(relPath, chunk.id);
      return { relPath, absPath };
    });
  }

  /**
   * Files-as-truth (benchmark): write a benchmark case into helm's
   * exclusive zone of the llm-wiki working copy —
   * `chat-captured/<user>/<role>/cases/<slug>.md` — so it rides the same
   * batch-MR publish + import flow as captured knowledge points. The
   * role is the case's first target role (fallback to 'imported' when
   * the case lists none). The importer re-keys by the fence id, so
   * there's no DB source_file column to maintain for cases.
   *
   * Runs under the repo lock so it can't interleave with a concurrent
   * fetch/import touching the same working copy.
   */
  async writeCaseFile(input: {
    repoId: string;
    caseId: string;
    /** Settings-provided wiki username — the <user> path segment. */
    username: string;
  }): Promise<{ relPath: string; absPath: string }> {
    const repo = getKnowledgeRepo(this.db, input.repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${input.repoId}`);
    }
    if (repo.profile !== 'llm-wiki') {
      throw new KnowledgeRepoManagerError(
        `writeCaseFile requires an llm-wiki repo (got profile=${repo.profile})`,
      );
    }
    const benchmarkCase = getCase(this.db, input.caseId);
    if (!benchmarkCase) {
      throw new KnowledgeRepoManagerError(`unknown case: ${input.caseId}`);
    }
    const user = sanitizePathSegment(input.username);
    const role = sanitizePathSegment(benchmarkCase.targetRoleIds[0] ?? 'imported');
    const slug = slugifyPointId(
      benchmarkCase.name,
      `case-${sha256Short(benchmarkCase.id).slice(0, 8)}`,
    );
    const file = sanitizePathSegment(slug);
    if (!user || !role || !file) {
      throw new KnowledgeRepoManagerError(
        `cannot build a cases path from username=${JSON.stringify(input.username)} role=${JSON.stringify(role)} caseId=${JSON.stringify(benchmarkCase.id)}`,
      );
    }
    const relPath = `chat-captured/${user}/${role}/cases/${file}.md`;
    return this.withRepoLock(input.repoId, async () => {
      const text = serializeCase({
        id: benchmarkCase.id,
        name: benchmarkCase.name,
        question: benchmarkCase.question,
        expectedTruth: benchmarkCase.expectedTruth,
        goldenPointIds: [...benchmarkCase.goldenPointIds],
        targetRoleIds: [...benchmarkCase.targetRoleIds],
      });
      const absPath = join(repo.localPath, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, text, 'utf8');
      return { relPath, absPath };
    });
  }

  /**
   * v28: top-level directories of the working copy that the import
   * whitelist can select from. chat-captured/ is excluded — it's
   * always imported, so listing it as a checkbox would mislead.
   */
  /**
   * Tree view for the import-dirs picker: top-level dirs with their
   * immediate sub-dirs (one level — deep nesting stays a whole-dir
   * choice). chat-captured/ excluded as always.
   */
  listRepoDirTree(repoId: string): Array<{ name: string; children: string[] }> {
    return this.listRepoTopDirs(repoId).map((name) => ({
      name,
      children: this.listRepoTopDirs(repoId, name),
    }));
  }

  listRepoTopDirs(repoId: string, parent?: string): string[] {
    const repo = getKnowledgeRepo(this.db, repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${repoId}`);
    }
    const root = parent
      ? join(repo.localPath, sanitizePathSegment(parent))
      : repo.localPath;
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => !name.startsWith('.') && !LLM_WIKI_SKIP_DIRS.has(name)
        && name !== 'chat-captured')
      .filter((name) => {
        try { return statSync(join(root, name)).isDirectory(); }
        catch { return false; }
      })
      .sort();
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

  /**
   * Topic-merge companion to `mergeRole` (storage side): physically move the
   * chat-captured files from the old topic's dir into the new topic's dir so
   * files-as-truth keeps pointing at the merged topic, AND so the next import
   * can't resurrect the old role from a leftover directory.
   *
   * Source dir = chat-captured/<user>/<fromRole>; target dir = …/<toRole>.
   * Every file (incl. the `cases/` subtree) is moved, sub-structure preserved;
   * an existing target file is overwritten. The now-empty source tree is
   * removed. Best-effort per file (a single failure doesn't abort the rest).
   *
   * Returns {moved:0} when the source dir doesn't exist (nothing to merge).
   * Runs under the repo lock so it can't interleave with a concurrent
   * fetch/import touching the same working copy.
   */
  async moveCapturedFilesForMerge(input: {
    repoId: string;
    fromRoleId: string;
    toRoleId: string;
    username: string;
  }): Promise<{ moved: number }> {
    const repo = getKnowledgeRepo(this.db, input.repoId);
    if (!repo) {
      throw new KnowledgeRepoManagerError(`unknown repo: ${input.repoId}`);
    }
    const user = sanitizePathSegment(input.username);
    const fromRole = sanitizePathSegment(input.fromRoleId);
    const toRole = sanitizePathSegment(input.toRoleId);
    if (!user || !fromRole || !toRole) {
      throw new KnowledgeRepoManagerError(
        `cannot build chat-captured paths from username=${JSON.stringify(input.username)} fromRoleId=${JSON.stringify(input.fromRoleId)} toRoleId=${JSON.stringify(input.toRoleId)}`,
      );
    }
    return this.withRepoLock(input.repoId, async () => {
      const sourceDir = join(repo.localPath, 'chat-captured', user, fromRole);
      const targetDir = join(repo.localPath, 'chat-captured', user, toRole);
      if (!existsSync(sourceDir)) return { moved: 0 };

      let moved = 0;
      // Recursive walk: collect every file relative to sourceDir, preserving
      // sub-structure (e.g. cases/<slug>.md).
      const walk = (rel: string): void => {
        const absDir = rel ? join(sourceDir, rel) : sourceDir;
        for (const entry of readdirSync(absDir, { withFileTypes: true })) {
          const childRel = rel ? join(rel, entry.name) : entry.name;
          if (entry.isDirectory()) {
            walk(childRel);
          } else {
            try {
              const srcAbs = join(sourceDir, childRel);
              const dstAbs = join(targetDir, childRel);
              mkdirSync(dirname(dstAbs), { recursive: true });
              // renameSync overwrites an existing target file on POSIX; on
              // collision we still want last-writer-wins, so remove first.
              if (existsSync(dstAbs)) rmSync(dstAbs, { force: true });
              renameSync(srcAbs, dstAbs);
              moved++;
            } catch { /* best-effort per file; keep going */ }
          }
        }
      };
      walk('');

      // Drop the now-empty source tree so a leftover dir can't resurrect the
      // old role on the next import.
      try { rmSync(sourceDir, { recursive: true, force: true }); } catch { /* swallow */ }
      return { moved };
    });
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

/**
 * Make a string safe as ONE path segment under chat-captured/: no
 * separators, no traversal, and no leading dot (the importer skips
 * hidden dirs, so a dotted segment would silently vanish from the
 * index). CJK and other word characters pass through unchanged.
 */
function sanitizePathSegment(seg: string): string {
  return seg
    .replace(/[\\/]+/g, '-')
    .replace(/\.\./g, '-')
    .trim()
    .replace(/^[.\-]+/, '')
    .replace(/[\-.]+$/, '');
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
