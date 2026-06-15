/**
 * Auto-propose ONE benchmark case from a freshly-accepted knowledge chunk.
 *
 * When a knowledge chunk lands in a topic (candidate accept / point edit),
 * we ask the LLM to draft a single realistic question a user would ask that
 * this knowledge answers, plus the expected-truth answer. The draft is
 * inserted as a `proposed` benchmark case — NOT written to a file.
 * Files-as-truth: the case file is only materialized when the user CONFIRMS
 * the case (see the confirm handler in src/api/server.ts).
 *
 * Best-effort everywhere: any LLM/parse/DB failure leaves the DB untouched
 * and returns {proposed:false}. The caller fires this fire-and-forget so it
 * never blocks the accept response.
 *
 * Mirrors the gist/extract patterns in this directory (tolerant fenced-JSON
 * parse, default sonnet model).
 */

import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { LlmClient } from './campaign.js';
import { getChunkById, getRole } from '../storage/repos/roles.js';
import { caseExistsForPoint, insertCase } from '../storage/repos/benchmark.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 800;
const MAX_CHUNK_CHARS = 4_000;

export interface ProposeDeps {
  llm: LlmClient;
  model?: string;
  maxTokens?: number;
}

export interface ProposeInput {
  roleId: string;
  chunkId: string;
  event?: 'candidate_accept' | 'point_edit';
}

export async function proposeBenchmarkCaseFromChunk(
  db: Database.Database,
  input: ProposeInput,
  deps: ProposeDeps,
): Promise<{ proposed: boolean }> {
  try {
    const chunk = getChunkById(db, input.chunkId);
    if (!chunk || !chunk.chunkText.trim()) return { proposed: false };

    // DEDUP: don't draft a second case for a point that already has a
    // proposed/confirmed case referencing it.
    if (caseExistsForPoint(db, input.chunkId)) return { proposed: false };

    const role = getRole(db, input.roleId);
    const topicName = role?.name ?? input.roleId;

    const prompt = buildPrompt(topicName, chunk.chunkText);
    let raw: string;
    try {
      raw = await deps.llm.generate(prompt, {
        model: deps.model ?? DEFAULT_MODEL,
        maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
    } catch {
      return { proposed: false };
    }

    const parsed = parseProposedCase(raw);
    if (!parsed) return { proposed: false };

    const questionHash = createHash('sha256')
      .update(parsed.question)
      .digest('hex')
      .slice(0, 32);

    insertCase(db, {
      id: randomUUID(),
      name: parsed.name,
      question: parsed.question,
      expectedTruth: parsed.expectedTruth,
      goldenPointIds: [input.chunkId],
      targetRoleIds: [input.roleId],
      proposedSource: 'llm-on-edit',
      proposedFromPointId: input.chunkId,
      proposedFromEvent: input.event ?? 'candidate_accept',
      proposedQuestionHash: questionHash,
      status: 'proposed',
    });
    return { proposed: true };
  } catch {
    return { proposed: false };
  }
}

// ── prompt ──────────────────────────────────────────────────────────────

function buildPrompt(topicName: string, chunkText: string): string {
  const text = chunkText.length > MAX_CHUNK_CHARS
    ? `${chunkText.slice(0, MAX_CHUNK_CHARS)}…[truncated]`
    : chunkText;
  return [
    'You design ONE benchmark test case from a single piece of durable knowledge.',
    `The knowledge belongs to the topic: "${topicName}".`,
    '',
    'Knowledge:',
    '---',
    text,
    '---',
    '',
    'Write one realistic question a real user would ask that THIS knowledge',
    'answers, and the expected-truth answer (the key points the answer must',
    'contain to be correct), and a short case name.',
    '',
    'Return ONLY JSON — no preamble, no markdown fence — shaped exactly like:',
    '{',
    '  "name": "<short case name, ≤80 chars>",',
    '  "question": "<the user question>",',
    '  "expectedTruth": "<the correct answer / key points the answer must contain>"',
    '}',
    '',
    'Rules:',
    '- The question must be answerable from the knowledge above — not generic.',
    '- expectedTruth states what a correct answer must include, concisely.',
    "- Use the knowledge's own language (Chinese knowledge → Chinese output).",
    '- Emit exactly one case.',
  ].join('\n');
}

// ── parse ───────────────────────────────────────────────────────────────

export interface ProposedCase {
  name: string;
  question: string;
  expectedTruth: string;
}

/**
 * Tolerant parse of the LLM's single-case JSON. Accepts a bare object or a
 * fenced ```json block. Returns null when the JSON is malformed or any of
 * name / question / expectedTruth is missing or empty.
 */
export function parseProposedCase(raw: string): ProposedCase | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  const name = typeof r['name'] === 'string' ? r['name'].trim().slice(0, 120) : '';
  const question = typeof r['question'] === 'string' ? r['question'].trim() : '';
  const expectedTruth = typeof r['expectedTruth'] === 'string' ? r['expectedTruth'].trim() : '';
  if (!name || !question || !expectedTruth) return null;
  return { name, question, expectedTruth };
}

function extractJsonObject(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1]!.trim();
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open === -1 || close === -1 || close <= open) return null;
  return raw.slice(open, close + 1);
}
