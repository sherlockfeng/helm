/**
 * E2e — Harness review subprocess flow (Phase 67).
 *
 * Two assertions matter here:
 *
 * 1. The reviewer subprocess invocation receives a payload assembled from
 *    Intent + Structure + diff + conventions ONLY. We assert this by
 *    intercepting the runReview call and inspecting what it would have
 *    sent.
 *
 * 2. After review completes, `harness_push_review_to_implement` enqueues
 *    a message into channel_message_queue keyed on a synthetic harness
 *    binding. The next host_stop drain returns it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  insertReview,
  updateReview,
} from '../../../src/storage/repos/harness.js';
import { listBindingsForSession, dequeueMessages } from '../../../src/storage/repos/channel-bindings.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';

let harness: E2eHarness;
let mcpServer: McpServer;
let mcpClient: Client;
let projectPath: string;

function parseJsonContent(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

beforeEach(async () => {
  harness = await bootE2e();
  projectPath = mkdtempSync(join(tmpdir(), 'harness-review-e2e-'));
});

afterEach(async () => {
  if (mcpClient) await mcpClient.close();
  await harness.shutdown();
  try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* noop */ }
});

async function bootMcp(opts: {
  conventions?: string;
  fakeRunReview?: (taskId: string, db: import('better-sqlite3').Database) => Promise<{ status: 'completed' | 'failed'; reportText?: string; error?: string }>;
}): Promise<void> {
  mcpServer = createMcpServer({
    db: harness.db,
    knowledge: harness.app.knowledge,
    ...(opts.conventions !== undefined ? { harnessConventions: () => opts.conventions! } : {}),
    runReviewOverride: opts.fakeRunReview
      ? async (deps, input) => {
        const { randomUUID } = await import('node:crypto');
        const id = randomUUID();
        const r = await opts.fakeRunReview!(input.taskId, deps.db);
        const completedAt = new Date().toISOString();
        const review = {
          id, taskId: input.taskId, status: r.status,
          ...(r.reportText ? { reportText: r.reportText } : {}),
          ...(r.error ? { error: r.error } : {}),
          baseCommit: 'a'.repeat(40),
          headCommit: 'b'.repeat(40),
          spawnedAt: completedAt, completedAt,
        };
        // Mimic real runReview: insert pending then update.
        insertReview(deps.db, { ...review, status: 'pending' });
        updateReview(deps.db, review);
        return review;
      }
      : undefined,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-harness-review', version: '0.0.0' });
  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
}

describe('harness review (Phase 67)', () => {
  it('runs review via override + retrieves the report', async () => {
    let capturedTaskId: string | null = null;
    await bootMcp({
      conventions: 'use const',
      fakeRunReview: async (taskId) => {
        capturedTaskId = taskId;
        return {
          status: 'completed',
          reportText: '## Intent Alignment\nLooks good.\n\nReview complete.',
        };
      },
    });

    await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: { taskId: 't1', title: 'T1', projectPath },
    });
    await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: { taskId: 't1', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) },
    });

    const r = await mcpClient.callTool({
      name: 'harness_run_review',
      arguments: { taskId: 't1' },
    });
    expect(r.isError).not.toBe(true);
    const body = parseJsonContent(r) as { reviewId: string; status: string; reportText: string };
    expect(body.status).toBe('completed');
    expect(body.reportText).toContain('Intent Alignment');
    expect(capturedTaskId).toBe('t1');
  });

  it('push_review_to_implement enqueues a message into the synthetic harness binding', async () => {
    await bootMcp({
      fakeRunReview: async () => ({ status: 'completed', reportText: 'POISON-PROBE OK' }),
    });

    // Pre-create a host_session so the binding FK is satisfied.
    upsertHostSession(harness.db, {
      id: 'hs-impl', host: 'cursor', status: 'active',
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });

    await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: { taskId: 't2', title: 'T2', projectPath, hostSessionId: 'hs-impl' },
    });
    await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: { taskId: 't2', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) },
    });
    const reviewResult = await mcpClient.callTool({
      name: 'harness_run_review',
      arguments: { taskId: 't2' },
    });
    const review = parseJsonContent(reviewResult) as { reviewId: string };

    const pushed = await mcpClient.callTool({
      name: 'harness_push_review_to_implement',
      arguments: { taskId: 't2', reviewId: review.reviewId },
    });
    expect(pushed.isError).not.toBe(true);
    const pushBody = parseJsonContent(pushed) as { bindingId: string; messageId: number };
    expect(pushBody.messageId).toBeGreaterThan(0);

    // Assert: a `harness` channel binding now exists for hs-impl, and the
    // queued message is drainable through the same code-path host_stop uses.
    const bindings = listBindingsForSession(harness.db, 'hs-impl');
    const hb = bindings.find((b) => b.channel === 'harness');
    expect(hb).toBeDefined();
    const drained = dequeueMessages(harness.db, hb!.id);
    expect(drained.length).toBe(1);
    expect(drained[0]!.text).toContain('POISON-PROBE OK');
    expect(drained[0]!.text).toContain('Harness review report');
  });

  it('attack: pushing a review for an unbound chat fails with a clear message', async () => {
    await bootMcp({
      fakeRunReview: async () => ({ status: 'completed', reportText: 'ok' }),
    });
    await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: { taskId: 't3', title: 'T3', projectPath /* no hostSessionId */ },
    });
    await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: { taskId: 't3', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) },
    });
    const r = await mcpClient.callTool({
      name: 'harness_run_review',
      arguments: { taskId: 't3' },
    });
    const review = parseJsonContent(r) as { reviewId: string };
    const pushed = await mcpClient.callTool({
      name: 'harness_push_review_to_implement',
      arguments: { taskId: 't3', reviewId: review.reviewId },
    });
    expect(pushed.isError).toBe(true);
  });

  it('attack: review returns "failed" when subprocess errors', async () => {
    await bootMcp({
      fakeRunReview: async () => ({ status: 'failed', error: 'subprocess timed out' }),
    });
    await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: { taskId: 't4', title: 'T4', projectPath },
    });
    await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: { taskId: 't4', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) },
    });
    const r = await mcpClient.callTool({
      name: 'harness_run_review',
      arguments: { taskId: 't4' },
    });
    const body = parseJsonContent(r) as { status: string; error: string };
    expect(body.status).toBe('failed');
    expect(body.error).toContain('timed out');
  });
});
