/**
 * Multipath retrieval benchmark fixture (Phase 76).
 *
 * Goal: produce a regression sentinel for the retrieval system. This file
 * is NOT a gate on absolute quality — the asserts are loose (≥0%) so the
 * suite never fails on small drift. The signal is the **stdout dump**:
 * R@5 / MRR per strategy, per query category. Read it during PR review;
 * if fusion's numbers drop noticeably below the strongest single leg
 * across multiple categories, something regressed.
 *
 * Why synthetic, not real corpus:
 *   - PR reviewers shouldn't need access to the user's private roles
 *   - The fixture must be deterministic across CI runs (real corpora
 *     drift)
 *   - The marker-embedder makes cosine results predictable
 *
 * Structure: 12 synthetic chunks across 4 categories, 8 queries each
 * with a single "truth" chunk ID. We measure:
 *   - **R@5**: did the truth chunk land in the top 5 results? (binary
 *     per query, averaged)
 *   - **MRR**: 1/rank of truth chunk, 0 if not in top 10
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let harness: E2eHarness;
let mcpServer: McpServer;
let mcpClient: Client;

const MARKERS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT'];
async function markerEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(MARKERS.length);
  for (let i = 0; i < MARKERS.length; i++) {
    if (text.toUpperCase().includes(MARKERS[i]!)) v[i] = 1;
  }
  let n = 0; for (const x of v) n += x * x;
  const d = Math.sqrt(n);
  if (d > 0) for (let i = 0; i < v.length; i++) v[i] /= d;
  return v;
}

function parseJson(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

/** Fixture: 12 chunks, 4 categories, each query has a unique truth chunk. */
const FIXTURE_DOCS = [
  // === Category A: BM25 sweet spot (literal acronym / verb match) ===
  { filename: 'tce-runbook.md', kind: 'runbook', truthKey: 'A1',
    content: 'ALPHA section. tce rollback procedure: identify failing service, run tce rollback <service>, verify with tce status.' },
  { filename: 'tps-runbook.md', kind: 'runbook', truthKey: 'A2',
    content: 'BRAVO section. tps throttle adjustment: open Lark thread, post tps throttle <region> <rps>.' },
  { filename: 'depscope-spec.md', kind: 'spec', truthKey: 'A3',
    content: 'CHARLIE section. depscope query format: provide scmName + cwdPrefix, server returns dep tree as JSON.' },

  // === Category B: cosine sweet spot (paraphrase / marker only) ===
  { filename: 'alpha-prose.md', kind: 'spec', truthKey: 'B1',
    content: 'ALPHA: incident-response philosophy values communication over heroics.' },
  { filename: 'bravo-prose.md', kind: 'spec', truthKey: 'B2',
    content: 'BRAVO: the platform optimizes for latency under burst load via batching.' },
  { filename: 'delta-prose.md', kind: 'spec', truthKey: 'B3',
    content: 'DELTA: knowledge sources expire via cascade-drop semantics, not soft-delete.' },

  // === Category C: entity sweet spot (camelCase / URL / acronym) ===
  { filename: 'api.md', kind: 'spec', truthKey: 'C1',
    content: 'ECHO area. The getCycleState() endpoint reads from the cycles table.' },
  { filename: 'webhook.md', kind: 'spec', truthKey: 'C2',
    content: 'FOXTROT area. ResponseHandler dispatches incoming webhook payloads to handlers by tool name.' },
  { filename: 'lark-doc.md', kind: 'spec', truthKey: 'C3',
    content: 'ALPHA area. See spec at https://bytedance.us.larkoffice.com/docx/Nd2CdKlYyojunFxP6ltuc7RysRg for the full table.' },

  // === Category D: multi-leg match (every leg should fire) ===
  { filename: 'csr-fallback.md', kind: 'runbook', truthKey: 'D1',
    content: 'BRAVO incident: CSR fallback runbook. If SSR errors, set __useFallback=1 and read https://help.example.com/csr.' },
  { filename: 'mr-policy.md', kind: 'spec', truthKey: 'D2',
    content: 'CHARLIE: MR review policy. Every MR requires getCycleState() trace + QA sign-off.' },
  { filename: 'mcp-tools.md', kind: 'spec', truthKey: 'D3',
    content: 'DELTA: helm exposes MCP tools like list_roles, update_role, harness_create_task.' },
] as const;

/** Each query's intended truth: which chunk should rank near the top? */
const QUERIES: Array<{ query: string; truthKey: string; category: 'A' | 'B' | 'C' | 'D' }> = [
  // Category A — BM25-shaped queries (verbatim phrases)
  { query: 'tce rollback procedure',          truthKey: 'A1', category: 'A' },
  { query: 'tps throttle adjustment',         truthKey: 'A2', category: 'A' },
  { query: 'depscope query format',           truthKey: 'A3', category: 'A' },

  // Category B — cosine-shaped (paraphrase)
  { query: 'ALPHA incident communication',    truthKey: 'B1', category: 'B' },
  { query: 'BRAVO burst load latency',        truthKey: 'B2', category: 'B' },
  { query: 'DELTA knowledge expiration',      truthKey: 'B3', category: 'B' },

  // Category C — entity queries (camelCase / URL)
  { query: 'getCycleState endpoint',          truthKey: 'C1', category: 'C' },
  { query: 'ResponseHandler webhook',         truthKey: 'C2', category: 'C' },
  { query: 'lark docx Nd2CdKlYyojunFxP6ltuc7RysRg', truthKey: 'C3', category: 'C' },

  // Category D — multi-leg (every leg has signal)
  { query: 'BRAVO CSR fallback runbook',      truthKey: 'D1', category: 'D' },
  { query: 'MR review getCycleState QA',      truthKey: 'D2', category: 'D' },
  { query: 'helm MCP tools update_role',      truthKey: 'D3', category: 'D' },
];

beforeEach(async () => {
  harness = await bootE2e();
  mcpServer = createMcpServer({
    db: harness.db,
    knowledge: harness.app.knowledge,
    embedFn: markerEmbed,
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-benchmark', version: '0.0.0' });
  await Promise.all([mcpServer.connect(s), mcpClient.connect(c)]);

  // Train the fixture role. Truth keys are encoded by giving each doc a
  // unique sourceFile we can match in search results.
  await mcpClient.callTool({
    name: 'train_role',
    arguments: {
      roleId: 'role-bench',
      name: 'Benchmark',
      documents: FIXTURE_DOCS.map((d) => ({
        filename: d.filename,
        content: d.content,
        kind: d.kind,
      })),
    },
  });
});

afterEach(async () => {
  await mcpClient.close();
  await harness.shutdown();
});

interface Metric { rAt5: number; mrr: number; coverage: Record<string, number> }

async function evaluate(strategy: 'fusion' | 'bm25' | 'cosine' | 'entity'): Promise<Metric> {
  let hits5 = 0;
  let rrSum = 0;
  const byCategory: Record<string, { hit: number; total: number }> = {};
  for (const { query, truthKey, category } of QUERIES) {
    byCategory[category] ??= { hit: 0, total: 0 };
    byCategory[category].total += 1;

    const out = parseJson(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-bench', query, topK: 10, strategy },
    })) as Array<{ sourceFile?: string; chunkText: string }>;

    // The truthKey we encoded maps to a unique filename: e.g. A1 = tce-runbook.md
    const truthFilename = FIXTURE_DOCS.find((d) => d.truthKey === truthKey)!.filename;
    const rank = out.findIndex((h) => h.sourceFile === truthFilename) + 1;
    if (rank > 0 && rank <= 5) {
      hits5 += 1;
      byCategory[category].hit += 1;
    }
    if (rank > 0) rrSum += 1 / rank;
  }
  const total = QUERIES.length;
  return {
    rAt5: hits5 / total,
    mrr: rrSum / total,
    coverage: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, v.hit / v.total]),
    ),
  };
}

function pct(x: number): string { return (x * 100).toFixed(1) + '%'; }

describe('multipath retrieval benchmark (Phase 76)', () => {
  it('runs the synthetic benchmark and reports R@5 / MRR per strategy', async () => {
    const fusion  = await evaluate('fusion');
    const bm25    = await evaluate('bm25');
    const cosine  = await evaluate('cosine');
    const entity  = await evaluate('entity');

    // Dump in a stable format so PR reviewers can eyeball trends.
    /* eslint-disable no-console */
    console.log('\n┌─ Phase 76 multipath retrieval benchmark ─────────────────────────┐');
    console.log(`│ corpus: ${FIXTURE_DOCS.length} chunks across 4 categories;`
              + ` ${QUERIES.length} queries`.padEnd(38) + '│');
    console.log('├──────────┬────────┬────────┬───────────────────────────────────┤');
    console.log('│ strategy │  R@5   │  MRR   │ R@5 by category (A/B/C/D)         │');
    console.log('├──────────┼────────┼────────┼───────────────────────────────────┤');
    const rows: Array<[string, Metric]> = [
      ['fusion', fusion], ['bm25', bm25], ['cosine', cosine], ['entity', entity],
    ];
    for (const [name, m] of rows) {
      const catStr = ['A', 'B', 'C', 'D']
        .map((k) => `${k}=${pct(m.coverage[k] ?? 0)}`)
        .join(' ');
      console.log(
        `│ ${name.padEnd(8)} │ ${pct(m.rAt5).padStart(6)} │ ${m.mrr.toFixed(3).padStart(6)} │ ${catStr.padEnd(33)} │`,
      );
    }
    console.log('└──────────┴────────┴────────┴───────────────────────────────────┘');
    /* eslint-enable no-console */

    // No hard assertions on absolute quality — see file docstring for
    // the rationale. The single assertion is a survival check: the test
    // ran and produced numbers in [0, 1].
    for (const [, m] of rows) {
      if (m.rAt5 < 0 || m.rAt5 > 1) throw new Error(`R@5 out of range: ${m.rAt5}`);
      if (m.mrr  < 0 || m.mrr  > 1) throw new Error(`MRR out of range: ${m.mrr}`);
    }
  });
});
