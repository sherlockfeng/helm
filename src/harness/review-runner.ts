/**
 * Review subprocess runner (Phase 67).
 *
 * Spawns `claude -p` (Phase 60b pattern) with a single-turn payload built by
 * `assembleReviewerPayload()`. The payload deliberately omits Decisions /
 * Stage Log — `assembleReviewerPayload` is the chokepoint and unit tests
 * cover that.
 *
 * Lifecycle:
 *   1. helm computes the diff (HEAD vs implement_base_commit) — see runReview
 *   2. inserts a HarnessReview row with status='pending'
 *   3. spawns claude -p, awaits stdout
 *   4. updates the row with status='completed' + report_text on success, or
 *      status='failed' + error on failure
 *
 * The runner does NOT auto-push the report to the implement chat. That's a
 * separate user-confirmed step (the "Push to implement chat" button in the
 * Harness page calls into helm's host_stop queue).
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  getHarnessTask,
  insertReview,
  updateReview,
} from '../storage/repos/harness.js';
import type { HarnessReview } from '../storage/types.js';
import { assembleReviewerPayload, REVIEW_SYSTEM_PROMPT } from './templates/review.js';

const execFileAsync = promisify(execFile);

export interface RunReviewDeps {
  db: Database.Database;
  /**
   * Returns the diff (head vs base) for the given project. Default
   * implementation shells out to `git diff <base> HEAD` in the project dir.
   * Tests substitute a fake.
   */
  computeDiff?: (projectPath: string, baseCommit: string) => Promise<{ headCommit: string; diff: string }>;
  /**
   * Returns the global Harness conventions text. Default reads from a helm
   * config provider; tests substitute a stub.
   */
  getConventions?: () => Promise<string>;
  /** Override the `claude` binary (testing). */
  claudeBin?: string;
  /** Override the spawner (testing). */
  exec?: typeof execFileAsync;
  /** Per-review timeout. Reviewers are usually short (<1 min) but allow long tail. */
  timeoutMs?: number;
  /**
   * helm's MCP SSE endpoint. The reviewer subprocess does NOT need it for the
   * MVP review flow — its job is read-only — but exposing it lets future
   * follow-ups give the reviewer access to e.g. `harness_search_archive`.
   */
  helmMcpUrl?: string;
}

export interface RunReviewInput {
  taskId: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';

export async function runReview(
  deps: RunReviewDeps,
  input: RunReviewInput,
): Promise<HarnessReview> {
  const task = getHarnessTask(deps.db, input.taskId);
  if (!task) throw new Error(`runReview: task not found: ${input.taskId}`);
  if (!task.implementBaseCommit) {
    throw new Error(
      `runReview: task ${task.id} has no implement_base_commit. `
      + 'Advance to implement first (which records HEAD as the base).',
    );
  }

  const reviewId = randomUUID();
  const spawnedAt = new Date().toISOString();
  const pending: HarnessReview = {
    id: reviewId,
    taskId: task.id,
    status: 'pending',
    baseCommit: task.implementBaseCommit,
    spawnedAt,
  };
  insertReview(deps.db, pending);

  try {
    const computeDiff = deps.computeDiff ?? defaultComputeDiff;
    const getConventions = deps.getConventions ?? (async () => '');
    const { headCommit, diff } = await computeDiff(task.projectPath, task.implementBaseCommit);
    const conventions = await getConventions();

    const payload = assembleReviewerPayload({ task, diff, conventions });
    const reportText = await spawnClaudeReview(payload, {
      claudeBin: deps.claudeBin,
      exec: deps.exec,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      helmMcpUrl: deps.helmMcpUrl ?? DEFAULT_HELM_MCP_URL,
      cwd: task.projectPath,
    });

    const completed: HarnessReview = {
      ...pending,
      status: 'completed',
      headCommit,
      reportText,
      completedAt: new Date().toISOString(),
    };
    updateReview(deps.db, completed);
    return completed;
  } catch (err) {
    const failed: HarnessReview = {
      ...pending,
      status: 'failed',
      error: (err as Error).message,
      completedAt: new Date().toISOString(),
    };
    updateReview(deps.db, failed);
    return failed;
  }
}

async function defaultComputeDiff(
  projectPath: string,
  baseCommit: string,
): Promise<{ headCommit: string; diff: string }> {
  // git rev-parse HEAD then git diff <base> HEAD. Two calls keep error
  // messages clean: if HEAD is missing we say so, vs "diff failed".
  const { stdout: headStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
  const headCommit = headStdout.toString().trim();
  // Validate base exists; git diff would print nothing for an unknown rev,
  // so we proactively cat-file --check it.
  try {
    await execFileAsync('git', ['cat-file', '-e', `${baseCommit}^{commit}`], { cwd: projectPath });
  } catch {
    throw new Error(
      `implement_base_commit ${baseCommit.slice(0, 8)} no longer exists in ${projectPath}. `
      + 'Was the branch reset? Update the task\'s base commit and retry.',
    );
  }
  const { stdout: diffStdout } = await execFileAsync(
    'git', ['diff', baseCommit, 'HEAD'],
    { cwd: projectPath, maxBuffer: 32 * 1024 * 1024 },
  );
  return { headCommit, diff: diffStdout.toString() };
}

interface SpawnOpts {
  claudeBin?: string;
  exec?: typeof execFileAsync;
  timeoutMs: number;
  helmMcpUrl: string;
  cwd: string;
}

async function spawnClaudeReview(payload: string, opts: SpawnOpts): Promise<string> {
  const claudeBin = opts.claudeBin ?? 'claude';
  const exec = opts.exec ?? execFileAsync;

  // Materialize a tmp MCP config so the reviewer CAN reach helm's MCP server
  // (read-only use cases like harness_search_archive). We don't use any MCP
  // tools by default in MVP, but having it wired keeps the door open.
  const dir = mkdtempSync(join(tmpdir(), 'helm-harness-review-'));
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { helm: { type: 'sse', url: opts.helmMcpUrl } } }, null, 2),
  );

  try {
    const args = [
      '--print',
      '--output-format', 'text',
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--append-system-prompt', REVIEW_SYSTEM_PROMPT,
      payload,
    ];
    const { stdout } = await exec(claudeBin, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return stdout.toString().trim();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
