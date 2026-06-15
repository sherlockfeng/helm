/**
 * One-time backfill: generate benchmark cases for a topic's EXISTING
 * knowledge, in one LLM pass.
 *
 * Where `benchmark-propose.ts` drafts ONE case per freshly-accepted chunk,
 * this pass looks at a whole topic's knowledge at once and asks the LLM for
 * up to N distinct, representative cases spanning the topic's main areas. It
 * is the "seed my benchmark from what I already know" button, run per topic.
 *
 * Every drafted case lands as `proposed` (imported) — file-less until the
 * user batch-confirms (see the confirm-batch handler in src/api/server.ts).
 *
 * Best-effort everywhere: any LLM/parse/DB failure returns whatever was
 * inserted so far ({proposed:0} in the worst case) and never throws out.
 *
 * Mirrors the tolerant fenced-JSON parse + default-sonnet model patterns in
 * this directory (chat-knowledge-extract.ts / benchmark-propose.ts).
 */

import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { LlmClient } from './campaign.js';
import { getChunksForRole, getRole } from '../storage/repos/roles.js';
import { insertCase, listCases } from '../storage/repos/benchmark.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 2500;
const DEFAULT_MAX_CASES = 8;
const MAX_PROMPT_CHARS = 12_000;
const POINT_TEXT_CAP = 200;

export interface BackfillDeps {
  llm: LlmClient;
  model?: string;
  maxTokens?: number;
  maxCases?: number;
}

export interface ParsedBackfillCase {
  name: string;
  question: string;
  expectedTruth: string;
  goldenPointIds: string[];
}

export async function proposeCasesForTopic(
  db: Database.Database,
  roleId: string,
  deps: BackfillDeps,
): Promise<{ proposed: number }> {
  let inserted = 0;
  try {
    const role = getRole(db, roleId);
    const topicName = role?.name ?? roleId;
    const chunks = getChunksForRole(db, roleId);
    if (chunks.length === 0) return { proposed: 0 };

    const maxCases = deps.maxCases ?? DEFAULT_MAX_CASES;
    const { prompt, validPointIds } = buildPrompt(topicName, chunks, maxCases);

    let raw: string;
    try {
      raw = await deps.llm.generate(prompt, {
        model: deps.model ?? DEFAULT_MODEL,
        maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
    } catch { return { proposed: 0 }; }

    const cases = parseBackfillCases(raw, validPointIds);

    // DEDUP across re-runs: skip a case whose question hash already exists
    // among this topic's proposed cases. Computed once up-front.
    const existingHashes = new Set(
      listCases(db, { roleId, status: 'proposed', limit: 500 })
        .map((c) => c.proposedQuestionHash)
        .filter((h): h is string => typeof h === 'string'),
    );

    for (const c of cases) {
      const hash = createHash('sha256').update(c.question).digest('hex').slice(0, 32);
      if (existingHashes.has(hash)) continue;
      try {
        insertCase(db, {
          id: randomUUID(),
          name: c.name,
          question: c.question,
          expectedTruth: c.expectedTruth,
          goldenPointIds: c.goldenPointIds,
          targetRoleIds: [roleId],
          proposedSource: 'imported',
          proposedQuestionHash: hash,
          status: 'proposed',
        });
        existingHashes.add(hash);
        inserted += 1;
      } catch { /* best-effort: skip this case, keep going */ }
    }
    return { proposed: inserted };
  } catch {
    return { proposed: inserted };
  }
}

// ── prompt ──────────────────────────────────────────────────────────────

function buildPrompt(
  topicName: string,
  chunks: ReadonlyArray<{ id: string; title?: string; chunkText: string }>,
  maxCases: number,
): { prompt: string; validPointIds: Set<string> } {
  const header = [
    `You generate up to ${maxCases} DISTINCT, representative benchmark cases for a`,
    `knowledge TOPIC: "${topicName}".`,
    '',
    'Below is a NUMBERED list of the topic\'s knowledge points (id + text).',
    'Knowledge points:',
  ].join('\n');

  const footer = [
    '',
    'Return ONLY JSON — no preamble — shaped like:',
    '{',
    '  "cases": [',
    '    {',
    '      "name": "<short slug-ish name>",',
    '      "question": "<a realistic question a user would ask>",',
    '      "expectedTruth": "<the correct answer, drawn from the knowledge above>",',
    '      "goldenPointIds": ["<id from the list that answers it>", "..."]',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    `- Up to ${maxCases} cases covering the topic\'s main knowledge areas; quality over`,
    '  quantity — fewer good cases is fine. Make each case DISTINCT.',
    '- Each question must be realistic AND answerable from THIS topic\'s knowledge.',
    '- goldenPointIds MUST be ids from the list above (the points that answer the',
    '  question). Drop ids you are unsure about; an empty list is allowed.',
    '- Use the knowledge\'s own language (Chinese knowledge → Chinese name/question/answer).',
    '- Return {"cases": []} if nothing is worth a case.',
  ].join('\n');

  const validPointIds = new Set<string>();
  const lines: string[] = [];
  let budget = MAX_PROMPT_CHARS - header.length - footer.length;
  for (const ch of chunks) {
    const body = truncate(ch.chunkText, POINT_TEXT_CAP);
    const label = ch.title?.trim() ? `${ch.title.trim()}: ${body}` : body;
    const line = `[${ch.id}] ${label}`;
    if (line.length + 1 > budget) break;
    lines.push(line);
    validPointIds.add(ch.id);
    budget -= line.length + 1;
  }

  const prompt = `${header}\n${lines.join('\n')}\n${footer}`;
  return { prompt, validPointIds };
}

function truncate(s: string, cap: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= cap ? t : `${t.slice(0, cap)}…`;
}

// ── parse ───────────────────────────────────────────────────────────────

export function parseBackfillCases(
  raw: string,
  validPointIds: Set<string>,
): ParsedBackfillCase[] {
  const json = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const arr = (parsed as Record<string, unknown>)['cases'];
  if (!Array.isArray(arr)) return [];

  const out: ParsedBackfillCase[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    const question = typeof r['question'] === 'string' ? r['question'].trim() : '';
    const expectedTruth = typeof r['expectedTruth'] === 'string' ? r['expectedTruth'].trim() : '';
    if (!name || !question || !expectedTruth) continue;
    const goldenPointIds = Array.isArray(r['goldenPointIds'])
      ? (r['goldenPointIds'] as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .filter((id) => validPointIds.has(id))
      : [];
    out.push({ name, question, expectedTruth, goldenPointIds });
  }
  return out;
}

function extractJsonObject(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1]!.trim();
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open === -1 || close === -1 || close <= open) return null;
  return raw.slice(open, close + 1);
}
