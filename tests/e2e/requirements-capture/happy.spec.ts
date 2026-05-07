/**
 * E2e — capture and recall a requirement via the MCP capture flow.
 *
 * The /requirements page is the user-facing surface; the agent-facing surface
 * is `capture_requirement` (multi-turn: start → answer → confirm) +
 * `recall_requirement`. This spec drives the agent path because it has the
 * tightest coupling — the renderer just lists what's already saved.
 *
 * The full sequence is the "save what we just figured out so the next chat
 * can recall it" flow that ties multiple sessions together. A regression
 * here means the user thinks they captured a requirement and finds nothing
 * the next day.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRequirement } from '../../../src/storage/repos/requirements.js';

let harness: E2eHarness;
let mcpServer: McpServer;
let mcpClient: Client;

function parseJsonContent(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

function textContent(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((b) => b.type === 'text')?.text ?? '';
}

beforeEach(async () => {
  harness = await bootE2e();
  mcpServer = createMcpServer({ db: harness.db, knowledge: harness.app.knowledge });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-requirements', version: '0.0.0' });
  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await mcpClient.close();
  await harness.shutdown();
});

describe('requirements-capture happy', () => {
  it('start → answer → confirm persists a requirement that recall_requirement can read back', async () => {
    // Step 1: start a capture session for a brand-new requirement.
    const startResult = await mcpClient.callTool({
      name: 'capture_requirement',
      arguments: {
        action: 'start',
        name: 'Helm approval gate',
        chatContext: 'we wired Phase 46a so unbound chats auto-allow',
      },
    });
    expect(startResult.isError).not.toBe(true);
    const startBody = parseJsonContent(startResult) as {
      sessionId: string;
      isUpdate: boolean;
      questions: Array<{ key: string; question: string }>;
    };
    expect(startBody.sessionId).toBeTruthy();
    expect(startBody.isUpdate).toBe(false);
    expect(startBody.questions.length).toBeGreaterThan(0);

    // Step 2: answer the clarifying questions. The capture engine accepts a
    // free-form Record<string,string> keyed by the question keys it surfaced.
    const answerResult = await mcpClient.callTool({
      name: 'capture_requirement',
      arguments: {
        action: 'answer',
        sessionId: startBody.sessionId,
        answers: {
          purpose: 'Reduce approval-popup spam from chats nobody is watching',
          background: 'See PROJECT_BLUEPRINT.md §46a',
          changes: '1. requireApproval predicate on handler\n2. orchestrator wires Lark binding lookup',
          outcome: 'Cursor chats without Lark bindings auto-allow; no behavior change for bound chats',
          tags: '体验改进, 架构调整',
        },
      },
    });
    expect(answerResult.isError).not.toBe(true);
    const answerBody = parseJsonContent(answerResult) as {
      phase: string; draft: { name?: string; purpose?: string };
    };
    expect(answerBody.phase).toBe('confirming');
    expect(answerBody.draft.purpose ?? '').toMatch(/spam|approval/i);

    // Step 3: confirm with a small edit so we exercise the merge path.
    const confirmResult = await mcpClient.callTool({
      name: 'capture_requirement',
      arguments: {
        action: 'confirm',
        sessionId: startBody.sessionId,
        edits: { tags: ['phase-46a', 'approval-gate'] },
      },
    });
    expect(confirmResult.isError).not.toBe(true);
    const confirmed = parseJsonContent(confirmResult) as {
      requirementId: string; name: string; status: string;
    };
    expect(confirmed.requirementId).toBeTruthy();
    expect(confirmed.status).toBe('confirmed');

    // The DB row matches the confirmed body — no drift between MCP response
    // and storage state.
    const stored = getRequirement(harness.db, confirmed.requirementId);
    expect(stored).toBeDefined();
    expect(stored!.tags).toEqual(['phase-46a', 'approval-gate']);

    // Step 4: recall_requirement returns the formatted text for an injection-
    // ready prompt. We just verify the salient fields appear; exact formatting
    // belongs to a unit test.
    const recallResult = await mcpClient.callTool({
      name: 'recall_requirement',
      arguments: { id: confirmed.requirementId },
    });
    expect(recallResult.isError).not.toBe(true);
    const recallText = textContent(recallResult);
    expect(recallText).toContain('Helm approval gate');
    expect(recallText.toLowerCase()).toContain('approval');
  });

  it('recall_requirement without args lists all confirmed requirements (briefly)', async () => {
    // Seed two requirements via the same capture flow (faster than direct DB
    // inserts since we want to validate the listing surface here).
    for (const name of ['First req', 'Second req']) {
      const start = parseJsonContent(await mcpClient.callTool({
        name: 'capture_requirement',
        arguments: { action: 'start', name, chatContext: `context for ${name}` },
      })) as { sessionId: string };
      await mcpClient.callTool({
        name: 'capture_requirement',
        arguments: {
          action: 'answer',
          sessionId: start.sessionId,
          answers: { purpose: 'p', background: '-', changes: '-', outcome: '-', tags: '-' },
        },
      });
      await mcpClient.callTool({
        name: 'capture_requirement',
        arguments: { action: 'confirm', sessionId: start.sessionId },
      });
    }

    const result = await mcpClient.callTool({ name: 'recall_requirement', arguments: {} });
    expect(result.isError).not.toBe(true);
    const list = parseJsonContent(result) as Array<{ id: string; name: string }>;
    expect(list.map((r) => r.name).sort()).toEqual(['First req', 'Second req']);
  });

  it('attack: confirm without a session id returns an error result, no DB row', async () => {
    const result = await mcpClient.callTool({
      name: 'capture_requirement',
      arguments: { action: 'confirm' },
    });
    expect(result.isError).toBe(true);
    // Ground truth: no requirement should have been created.
    const rows = harness.db.prepare(`SELECT count(*) AS n FROM requirements`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('attack: answer with unknown sessionId returns isError, no orphan requirement', async () => {
    // The MCP SDK wraps thrown tool errors as `{ isError: true, content: [...] }`
    // rather than rejecting the promise — so the contract here is "the tool
    // surfaced an error AND nothing landed in the DB".
    const result = await mcpClient.callTool({
      name: 'capture_requirement',
      arguments: {
        action: 'answer',
        sessionId: 'session-ghost',
        answers: { purpose: 'X' },
      },
    });
    expect(result.isError).toBe(true);

    const rows = harness.db.prepare(`SELECT count(*) AS n FROM requirements`).get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
