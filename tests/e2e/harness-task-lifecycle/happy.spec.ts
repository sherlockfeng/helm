/**
 * E2e — Harness task lifecycle (Phase 67).
 *
 * Walk a single task end-to-end through the MCP surface:
 *   create → advance(implement) → archive → search_archive surfaces it
 *
 * The review subprocess is mocked via `runReviewOverride` injected into
 * createMcpServer; we don't actually shell out to claude here. A separate
 * spec (`review.spec.ts`) covers the reviewer-isolation contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
  projectPath = mkdtempSync(join(tmpdir(), 'harness-e2e-'));
  mcpServer = createMcpServer({
    db: harness.db,
    knowledge: harness.app.knowledge,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-harness', version: '0.0.0' });
  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await mcpClient.close();
  await harness.shutdown();
  try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('harness lifecycle (happy)', () => {
  it('create → advance → archive writes files + index, search surfaces it', async () => {
    // 1. Create.
    const created = await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: {
        taskId: '2026-05-10-tce-rollout',
        title: 'TCE rollout dashboard',
        projectPath,
        intent: {
          background: 'team needs visibility into rollout state',
          objective: 'one dashboard showing all running rollouts',
          scopeIn: ['rollout list view', 'live status badges'],
          scopeOut: ['cross-region aggregation'],
        },
      },
    });
    expect(created.isError).not.toBe(true);
    const cBody = parseJsonContent(created) as { taskId: string; currentStage: string };
    expect(cBody.currentStage).toBe('new_feature');
    expect(existsSync(join(projectPath, '.harness/tasks/2026-05-10-tce-rollout/task.md'))).toBe(true);

    // 2. Advance to implement (with a fake base commit).
    const advanced = await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: {
        taskId: '2026-05-10-tce-rollout',
        toStage: 'implement',
        implementBaseCommit: 'b'.repeat(40),
        message: 'going build',
      },
    });
    expect(advanced.isError).not.toBe(true);
    expect((parseJsonContent(advanced) as { currentStage: string }).currentStage).toBe('implement');

    // 3. Update some fields mid-implement.
    const updated = await mcpClient.callTool({
      name: 'harness_update_field',
      arguments: {
        taskId: '2026-05-10-tce-rollout',
        field: 'decisions',
        value: ['used SSE for live status; chose polling fallback for 4xx'],
      },
    });
    expect(updated.isError).not.toBe(true);

    // 4. Archive.
    const archived = await mcpClient.callTool({
      name: 'harness_archive',
      arguments: {
        taskId: '2026-05-10-tce-rollout',
        oneLiner: 'Built the TCE rollout dashboard',
        entities: ['Rollout', 'Dashboard'],
        filesTouched: ['src/dashboard/rollout.tsx', 'src/api/rollouts.ts'],
        modules: ['dashboard', 'api'],
        patterns: ['SSE long-poll fallback'],
      },
    });
    expect(archived.isError).not.toBe(true);
    const aBody = parseJsonContent(archived) as { currentStage: string; archiveCard: { entities: string[] } };
    expect(aBody.currentStage).toBe('archived');
    expect(aBody.archiveCard.entities).toEqual(['Rollout', 'Dashboard']);
    expect(existsSync(join(projectPath, '.harness/archive/2026-05-10-tce-rollout.md'))).toBe(true);

    // 5. Search picks it up by entity.
    const searched = await mcpClient.callTool({
      name: 'harness_search_archive',
      arguments: { tokens: ['Rollout'], projectPath },
    });
    const cards = parseJsonContent(searched) as Array<{ taskId: string }>;
    expect(cards.map((c) => c.taskId)).toContain('2026-05-10-tce-rollout');
  });

  it('Related Tasks auto-fills on create when archive matches intent tokens', async () => {
    // Seed a prior archived task.
    await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: { taskId: '2026-04-01-prior', title: 'Order checkout', projectPath },
    });
    await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: {
        taskId: '2026-04-01-prior',
        toStage: 'implement',
        implementBaseCommit: 'a'.repeat(40),
      },
    });
    await mcpClient.callTool({
      name: 'harness_archive',
      arguments: {
        taskId: '2026-04-01-prior',
        oneLiner: 'Built Order checkout',
        entities: ['Order', 'Checkout'],
        filesTouched: ['src/order.ts'],
      },
    });

    // New task with overlapping intent.
    const r = await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: {
        taskId: '2026-05-10-refunds',
        title: 'Order refunds',
        projectPath,
        intent: { background: 'extend Order entity for refunds' },
      },
    });
    const body = parseJsonContent(r) as { relatedFound: Array<{ taskId: string }> };
    expect(body.relatedFound.map((rt) => rt.taskId)).toContain('2026-04-01-prior');
  });

  it('attack: advance backwards is rejected', async () => {
    await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: { taskId: 'rev', title: 'rev', projectPath },
    });
    await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: {
        taskId: 'rev', toStage: 'implement',
        implementBaseCommit: 'a'.repeat(40),
      },
    });
    // implement → implement is also a forward-move violation
    const r = await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: { taskId: 'rev', toStage: 'implement' },
    });
    expect(r.isError).toBe(true);
  });

  it('attack: advance to implement without base commit is rejected', async () => {
    await mcpClient.callTool({
      name: 'harness_create_task',
      arguments: { taskId: 'nb', title: 'no base', projectPath },
    });
    const r = await mcpClient.callTool({
      name: 'harness_advance_stage',
      arguments: { taskId: 'nb', toStage: 'implement' },
    });
    expect(r.isError).toBe(true);
  });

  it('attack: get_task on unknown id returns isError', async () => {
    const r = await mcpClient.callTool({
      name: 'harness_get_task',
      arguments: { taskId: 'never-existed' },
    });
    expect(r.isError).toBe(true);
  });
});
