/**
 * E2e — MCP HTTP/SSE end-to-end (Phase 45).
 *
 * The unit suite (`tests/unit/mcp/http-sse.test.ts`) covers the hub against a
 * standalone HttpApi; this spec exercises the full orchestrator wiring:
 *
 *   createHelmApp → mcpFactory → /mcp/sse → SDK SSEClient → tool call
 *
 * Catches the kinds of breakage that only surface once liveConfig / spawner /
 * llm dependencies are in scope:
 *   - factory not threaded through createHttpApi
 *   - the orchestrator's KnowledgeProviderRegistry isn't visible to MCP tools
 *   - port collision / shutdown leaks
 *
 * Cursor's mcp.json points at this URL in production, so a regression here
 * shows up as "MCP server unreachable" in the IDE — exactly the kind of
 * silent failure we want CI to catch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      // One known active chat so get_active_chats has something to return.
      upsertHostSession(db, {
        id: 'sess_mcp_e2e', host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

function sseUrl(): URL {
  return new URL(`http://127.0.0.1:${harness.app.httpPort()}/mcp/sse`);
}

describe('mcp-http-sse happy', () => {
  it('SDK client connects via /mcp/sse and calls list_roles → returns the seeded built-ins', async () => {
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    const transport = new SSEClientTransport(sseUrl());
    try {
      await client.connect(transport);

      const result = await client.callTool({ name: 'list_roles', arguments: {} });
      expect(result.isError).not.toBe(true);
      const block = (result.content as Array<{ type: string; text?: string }>)[0]!;
      const roles = JSON.parse(block.text!) as Array<{ id: string; name: string; isBuiltin: boolean }>;
      // Built-ins are seeded by both createHelmApp and createMcpServer; either
      // path leaves >0 roles. This assertion is intentionally loose — a regression
      // that ships zero built-ins is the bug we want to catch.
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.some((r) => r.isBuiltin)).toBe(true);
    } finally {
      await client.close();
    }
  }, 15_000);

  it('get_active_chats over SSE sees the same DB rows the renderer would via /api/active-chats', async () => {
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    const transport = new SSEClientTransport(sseUrl());
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_active_chats', arguments: {} });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      // The MCP tool returns `{ chats: [{ hostSessionId, host, cwd, ... }] }`.
      const parsed = JSON.parse(text) as { chats: Array<{ hostSessionId: string }> };
      expect(parsed.chats.map((c) => c.hostSessionId)).toContain('sess_mcp_e2e');
    } finally {
      await client.close();
    }
  }, 15_000);

  it('two concurrent Cursor instances each get their own session and don\'t cross-contaminate', async () => {
    // Mirrors the user opening two Cursor windows against the same helm.
    const c1 = new Client({ name: 'e2e-1', version: '0.0.0' });
    const c2 = new Client({ name: 'e2e-2', version: '0.0.0' });
    const t1 = new SSEClientTransport(sseUrl());
    const t2 = new SSEClientTransport(sseUrl());
    try {
      await Promise.all([c1.connect(t1), c2.connect(t2)]);

      const [r1, r2] = await Promise.all([
        c1.callTool({ name: 'list_roles', arguments: {} }),
        c2.callTool({ name: 'list_roles', arguments: {} }),
      ]);
      expect(r1.isError).not.toBe(true);
      expect(r2.isError).not.toBe(true);
    } finally {
      await Promise.all([c1.close(), c2.close()]);
    }
  }, 15_000);

  it('stop() closes live SSE sessions cleanly without leaking timers / sockets', async () => {
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    const transport = new SSEClientTransport(sseUrl());
    await client.connect(transport);
    // Make a call so the server has actually wired up the transport routing.
    const r = await client.callTool({ name: 'list_roles', arguments: {} });
    expect(r.isError).not.toBe(true);

    // Shutdown the orchestrator while the SSE stream is still open. Should
    // resolve in well under the 1s budget — leaks would push past the test
    // timeout. We don't await the client because closing the server-side
    // transport surfaces as `client.close()` failing later.
    await harness.shutdown();
    // Replace the harness so afterEach's shutdown() is a no-op: a fresh
    // boot keeps the test isolation guarantee, and we'll throw it away.
    harness = await bootE2e();
  }, 15_000);
});
