/**
 * Phase 66 — conflict detection on update_role.
 *
 * `update_role` runs an explicit similarity scan between each new chunk and
 * every existing chunk for the role. When any pair scores ≥ CONFLICT_THRESHOLD
 * (cosine similarity), the tool returns `{ status: "conflicts", conflicts: ... }`
 * WITHOUT touching the DB. The agent must surface the overlap to the user;
 * the user then decides per conflict whether to keep both (re-call with
 * `force: true`) or replace (delete_role_chunk + force=true).
 *
 * Why a custom embedder for these tests:
 * The default pseudo-embedder is a char-bin bag — two random English
 * sentences share enough characters to land near 1.0 cosine, so it's
 * unusable for asserting "this should NOT conflict". This file injects a
 * marker-keyword embedder where similarity is 1.0 iff the texts share a
 * marker token, 0 otherwise. That lets us pin exact yes/no assertions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getChunksForRole } from '../../../src/storage/repos/roles.js';

let harness: E2eHarness;
let mcpServer: McpServer;
let mcpClient: Client;

const MARKERS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'] as const;

/**
 * Marker-keyword embedder. Vector dimension = number of markers; bin i is
 * set when the corresponding marker token appears in the text. L2-normalized
 * so cosine is well-defined. Two texts sharing the same marker(s) → 1.0;
 * disjoint markers → 0.
 */
async function markerEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(MARKERS.length);
  for (let i = 0; i < MARKERS.length; i++) {
    if (text.includes(MARKERS[i]!)) v[i] = 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  const d = Math.sqrt(n);
  if (d > 0) for (let i = 0; i < v.length; i++) v[i] /= d;
  return v;
}

function parseJsonContent(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

beforeEach(async () => {
  harness = await bootE2e();
  // Override the embedder so similarity assertions are deterministic. Same
  // db / knowledge wiring as the happy spec — only the embedder changes.
  mcpServer = createMcpServer({
    db: harness.db,
    knowledge: harness.app.knowledge,
    embedFn: markerEmbed,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-roles-conflict', version: '0.0.0' });
  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await mcpClient.close();
  await harness.shutdown();
});

describe('roles-update conflict detection (Phase 66)', () => {
  it('append with overlapping content surfaces conflicts and writes nothing', async () => {
    // Seed: one chunk with ALPHA marker.
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-conflict',
        name: 'Conflict Role',
        documents: [{ filename: 'old.md', content: 'old runbook ALPHA — paged at midnight' }],
      },
    });
    const seedChunks = getChunksForRole(harness.db, 'role-conflict');
    expect(seedChunks.length).toBe(1);
    const seedId = seedChunks[0]!.id;

    // Update: a new doc that ALSO carries ALPHA → marker-vector identical.
    const r = await mcpClient.callTool({
      name: 'update_role',
      arguments: {
        roleId: 'role-conflict',
        appendDocuments: [{
          filename: 'new.md',
          content: 'new runbook ALPHA — paged whenever the dashboard goes red',
        }],
      },
    });
    expect(r.isError).not.toBe(true);
    const body = parseJsonContent(r) as {
      status: string;
      conflicts: Array<{
        existingChunkId: string;
        existingChunkText: string;
        newChunkText: string;
        similarity: number;
        newDocFilename: string;
        newDocIndex: number;
      }>;
    };

    expect(body.status).toBe('conflicts');
    expect(body.conflicts).toHaveLength(1);
    const conflict = body.conflicts[0]!;
    expect(conflict.existingChunkId).toBe(seedId);
    expect(conflict.existingChunkText).toContain('old runbook ALPHA');
    expect(conflict.newChunkText).toContain('new runbook ALPHA');
    expect(conflict.newDocFilename).toBe('new.md');
    expect(conflict.newDocIndex).toBe(0);
    expect(conflict.similarity).toBeGreaterThanOrEqual(0.85);

    // Critical: the DB must NOT have been written. The whole point of
    // detection is "ask first, then act".
    const after = getChunksForRole(harness.db, 'role-conflict');
    expect(after.length).toBe(1);
    expect(after[0]!.id).toBe(seedId);
    expect(after.some((c) => /new runbook/.test(c.chunkText))).toBe(false);
  });

  it('append with non-overlapping content (different markers) lands as applied', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-disjoint',
        name: 'Disjoint Role',
        documents: [{ filename: 'a.md', content: 'topic ALPHA notes' }],
      },
    });
    const before = getChunksForRole(harness.db, 'role-disjoint').length;

    // BRAVO is a totally different marker → cosine = 0 with the ALPHA chunk.
    const r = await mcpClient.callTool({
      name: 'update_role',
      arguments: {
        roleId: 'role-disjoint',
        appendDocuments: [{ filename: 'b.md', content: 'topic BRAVO is unrelated' }],
      },
    });
    expect(r.isError).not.toBe(true);
    const body = parseJsonContent(r) as {
      status: string; chunksAdded: number; totalChunks: number;
    };
    expect(body.status).toBe('applied');
    expect(body.chunksAdded).toBeGreaterThan(0);

    const after = getChunksForRole(harness.db, 'role-disjoint');
    expect(after.length).toBe(before + body.chunksAdded);
    expect(after.some((c) => /BRAVO/.test(c.chunkText))).toBe(true);
    expect(after.some((c) => /ALPHA/.test(c.chunkText))).toBe(true);
  });

  it('force=true bypasses detection — both versions coexist', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-force',
        name: 'Force Role',
        documents: [{ filename: 'old.md', content: 'old CHARLIE runbook' }],
      },
    });

    // Without force → conflicts (we re-verify the gate so the test isn't
    // trusting the previous case to have established it).
    const dryRun = await mcpClient.callTool({
      name: 'update_role',
      arguments: {
        roleId: 'role-force',
        appendDocuments: [{ filename: 'new.md', content: 'new CHARLIE runbook' }],
      },
    });
    const dry = parseJsonContent(dryRun) as { status: string };
    expect(dry.status).toBe('conflicts');

    // With force=true → write goes through despite the overlap.
    const forced = await mcpClient.callTool({
      name: 'update_role',
      arguments: {
        roleId: 'role-force',
        appendDocuments: [{ filename: 'new.md', content: 'new CHARLIE runbook' }],
        force: true,
      },
    });
    expect(forced.isError).not.toBe(true);
    const body = parseJsonContent(forced) as { status: string; chunksAdded: number };
    expect(body.status).toBe('applied');
    expect(body.chunksAdded).toBeGreaterThan(0);

    const chunks = getChunksForRole(harness.db, 'role-force');
    // Both old and new chunks present — force = "keep both, user decided".
    expect(chunks.some((c) => /old CHARLIE/.test(c.chunkText))).toBe(true);
    expect(chunks.some((c) => /new CHARLIE/.test(c.chunkText))).toBe(true);
  });

  it('resolution flow: detect → delete_role_chunk on the old id → re-call with force=true', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-resolve',
        name: 'Resolve Role',
        documents: [{ filename: 'old.md', content: 'stale DELTA wisdom' }],
      },
    });

    // 1. Trigger detection.
    const detect = await mcpClient.callTool({
      name: 'update_role',
      arguments: {
        roleId: 'role-resolve',
        appendDocuments: [{ filename: 'fresh.md', content: 'corrected DELTA wisdom' }],
      },
    });
    const detected = parseJsonContent(detect) as {
      status: string;
      conflicts: Array<{ existingChunkId: string }>;
    };
    expect(detected.status).toBe('conflicts');
    const oldId = detected.conflicts[0]!.existingChunkId;

    // 2. User picks "replace" → delete the old chunk by id.
    const del = await mcpClient.callTool({
      name: 'delete_role_chunk',
      arguments: { chunkId: oldId },
    });
    expect(del.isError).not.toBe(true);
    expect(parseJsonContent(del)).toEqual({ chunkId: oldId, removed: true });

    // 3. Re-call with force=true (no longer strictly needed since the old
    // chunk is gone, but agents will pass force=true after a delete to make
    // the intent explicit + handle multi-conflict cases atomically).
    const apply = await mcpClient.callTool({
      name: 'update_role',
      arguments: {
        roleId: 'role-resolve',
        appendDocuments: [{ filename: 'fresh.md', content: 'corrected DELTA wisdom' }],
        force: true,
      },
    });
    const applied = parseJsonContent(apply) as { status: string };
    expect(applied.status).toBe('applied');

    // Old wisdom dropped, new wisdom in. Net: one chunk, the corrected one.
    const chunks = getChunksForRole(harness.db, 'role-resolve');
    expect(chunks.some((c) => /stale DELTA/.test(c.chunkText))).toBe(false);
    expect(chunks.some((c) => /corrected DELTA/.test(c.chunkText))).toBe(true);
  });

  it('delete_role_chunk on unknown id is idempotent (returns removed=false)', async () => {
    const r = await mcpClient.callTool({
      name: 'delete_role_chunk',
      arguments: { chunkId: 'does-not-exist' },
    });
    expect(r.isError).not.toBe(true);
    expect(parseJsonContent(r)).toEqual({
      chunkId: 'does-not-exist', removed: false,
    });
  });

  it('name-only update is never blocked by conflicts (no docs to scan)', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-rename',
        name: 'old name',
        documents: [{ filename: 'doc.md', content: 'ECHO content' }],
      },
    });

    // Update only the name. No appendDocuments → no scan → must apply
    // straight through even though the role has chunks.
    const r = await mcpClient.callTool({
      name: 'update_role',
      arguments: { roleId: 'role-rename', name: 'shiny new name' },
    });
    expect(r.isError).not.toBe(true);
    expect((parseJsonContent(r) as { status: string }).status).toBe('applied');

    const role = parseJsonContent(
      await mcpClient.callTool({ name: 'get_role', arguments: { roleId: 'role-rename' } }),
    ) as { name: string };
    expect(role.name).toBe('shiny new name');
  });
});
