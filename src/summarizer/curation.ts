/**
 * LLM-driven curation pass (PR-B).
 *
 * Given a chat and a target role, asks the LLM to produce a structured
 * report:
 *   - UPDATES: existing chunks the chat refines, contradicts, or
 *              elaborates on, with the proposed replacement text.
 *   - NEW    : novel knowledge points not covered by any existing chunk,
 *              with a one-line gist + a classified kind.
 *
 * Both flavors land in `knowledge_candidates`; UPDATEs carry a
 * `target_chunk_id` pointer back to the chunk they refine. The
 * renderer's KNOWLEDGE OUT splits the list by `target_chunk_id != null`.
 *
 * This module is best-effort: any LLM/parse failure leaves the DB
 * untouched and returns an empty result. Callers are expected to wrap
 * the invocation in a try/catch + sync-throw guard (see orchestrator's
 * existing pattern for engineRouter.current()).
 */

import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { LlmClient } from './campaign.js';
import { getRole, getChunksForRole } from '../storage/repos/roles.js';
import { listHostEvents } from '../storage/repos/host-event-log.js';
import { groupEventsIntoTurns } from '../api/conversation-detail.js';
import { insertCandidateIfNew } from '../storage/repos/knowledge-candidates.js';
import {
  KNOWLEDGE_CHUNK_KINDS,
  type KnowledgeChunkKind,
  type KnowledgeCandidate,
} from '../storage/types.js';

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
/** Chat transcript truncation budget — tail-most chars. */
const MAX_CHAT_CHARS = 16_000;
/** Per-chunk text cap when listing existing chunks for the LLM context. */
const CHUNK_BLURB_CHARS = 240;
/** Max existing chunks summarised in the prompt; older / archived skipped. */
const MAX_EXISTING_CHUNKS = 50;

const KIND_SET = new Set(KNOWLEDGE_CHUNK_KINDS);

export interface CurationDeps {
  llm: LlmClient;
  model?: string;
  maxTokens?: number;
}

export interface CurationResult {
  updateCount: number;
  newCount: number;
  candidateIds: string[];
}

/**
 * Run a single curation pass for one chat × role. Writes candidates to
 * the DB and returns a tally so the caller can refresh / report.
 *
 * Returns { updateCount: 0, newCount: 0 } on any failure path; callers
 * should treat the report as best-effort.
 */
export async function runCurationForRole(
  db: Database.Database,
  hostSessionId: string,
  roleId: string,
  deps: CurationDeps,
): Promise<CurationResult> {
  const empty: CurationResult = { updateCount: 0, newCount: 0, candidateIds: [] };

  const role = getRole(db, roleId);
  if (!role) return empty;

  const events = listHostEvents(db, hostSessionId, { limit: 500 });
  const turns = groupEventsIntoTurns(events);
  if (turns.length === 0) return empty;

  const existingChunks = getChunksForRole(db, roleId).slice(0, MAX_EXISTING_CHUNKS);
  const chatBlob = renderChatForPrompt(turns);
  const prompt = buildPrompt(role.name, role.systemPrompt, existingChunks, chatBlob);

  let raw: string;
  try {
    raw = await deps.llm.generate(prompt, {
      model: deps.model ?? DEFAULT_MODEL,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  } catch {
    return empty;
  }

  const parsed = parseCurationResponse(raw);
  if (!parsed) return empty;

  const validChunkIds = new Set(existingChunks.map((c) => c.id));
  const now = new Date().toISOString();
  const ids: string[] = [];
  let updateCount = 0;
  let newCount = 0;

  for (const item of parsed.updates) {
    if (!validChunkIds.has(item.targetChunkId)) continue; // model hallucinated id
    const candidate = buildCandidate({
      hostSessionId, roleId, now,
      text: item.proposedText,
      gist: item.gist,
      kind: item.kind,
      targetChunkId: item.targetChunkId,
    });
    if (insertCandidateIfNew(db, candidate)) {
      ids.push(candidate.id);
      updateCount += 1;
    }
  }

  for (const item of parsed.newPoints) {
    const candidate = buildCandidate({
      hostSessionId, roleId, now,
      text: item.chunkText,
      gist: item.gist,
      kind: item.kind,
    });
    if (insertCandidateIfNew(db, candidate)) {
      ids.push(candidate.id);
      newCount += 1;
    }
  }

  return { updateCount, newCount, candidateIds: ids };
}

// ── Prompt construction ──────────────────────────────────────────────────

function renderChatForPrompt(
  turns: ReadonlyArray<{
    userPrompt: { text: string };
    assistantResponse?: { text: string };
  }>,
): string {
  const lines: string[] = [];
  for (const t of turns) {
    lines.push(`USER: ${truncate(t.userPrompt.text, 1200)}`);
    if (t.assistantResponse) lines.push(`AI: ${truncate(t.assistantResponse.text, 1200)}`);
  }
  let text = lines.join('\n\n');
  if (text.length > MAX_CHAT_CHARS) {
    text = `[…older turns elided…]\n${text.slice(text.length - MAX_CHAT_CHARS)}`;
  }
  return text;
}

function truncate(text: string, cap: number): string {
  const t = text.trim();
  return t.length <= cap ? t : `${t.slice(0, cap)}…[truncated]`;
}

interface ExistingChunkBlurb { id: string; title?: string; text: string }

function renderExistingChunks(
  chunks: ReadonlyArray<{ id: string; title?: string; chunkText: string }>,
): ExistingChunkBlurb[] {
  return chunks.map((c) => ({
    id: c.id,
    title: c.title,
    text: truncate(c.chunkText, CHUNK_BLURB_CHARS),
  }));
}

function buildPrompt(
  roleName: string,
  rolePrompt: string,
  existingChunks: ReadonlyArray<{ id: string; title?: string; chunkText: string }>,
  chatBlob: string,
): string {
  const blurbs = renderExistingChunks(existingChunks);
  const existingBlock = blurbs.length === 0
    ? '(this role has no chunks yet)'
    : blurbs.map((b) => `[${b.id}] ${b.title ?? '(untitled)'}: ${b.text}`).join('\n');

  return [
    `You are helping curate the knowledge base for role "${roleName}".`,
    `Role's purpose: ${truncate(rolePrompt, 600)}`,
    '',
    `Existing knowledge chunks (id + title + first ~${CHUNK_BLURB_CHARS} chars):`,
    existingBlock,
    '',
    'Conversation to mine:',
    '---',
    chatBlob,
    '---',
    '',
    'Produce a JSON report — and ONLY the JSON, no preamble — with two arrays:',
    '',
    '{',
    '  "updates": [',
    '    {',
    '      "targetChunkId": "<id from the list above, NEVER invent ids>",',
    '      "kind": "spec|example|warning|runbook|glossary|decision|workaround|other",',
    '      "gist": "<one-line headline in the chat\'s language, ≤100 chars>",',
    '      "proposedText": "<replacement chunk text, markdown OK>"',
    '    }',
    '  ],',
    '  "newPoints": [',
    '    {',
    '      "kind": "spec|example|warning|runbook|glossary|decision|open_question|workaround|other",',
    '      "gist": "<one-line headline, ≤100 chars>",',
    '      "chunkText": "<the knowledge as a self-contained chunk, markdown OK>"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Only emit an UPDATE when the conversation OBVIOUSLY refines / contradicts / supersedes an existing chunk. When in doubt, prefer newPoints.',
    '- Only emit a NEW point if it is a durable knowledge fact, not chat scaffolding (questions, plans, status updates).',
    '- Use the chat\'s own language for gist + chunkText (Chinese chats → Chinese output).',
    '- decision: a choice and its rationale ("we picked X over Y because Z").',
    '- open_question: an explicit unknown the chat surfaces.',
    '- workaround: a temporary hack with stated limits.',
    '- It\'s perfectly fine to return both arrays empty if the conversation has no curate-worthy content.',
  ].join('\n');
}

// ── Parse / persist ──────────────────────────────────────────────────────

export interface ParsedUpdate {
  targetChunkId: string;
  kind: KnowledgeChunkKind;
  gist: string;
  proposedText: string;
}

export interface ParsedNewPoint {
  kind: KnowledgeChunkKind;
  gist: string;
  chunkText: string;
}

export interface ParsedCuration {
  updates: ParsedUpdate[];
  newPoints: ParsedNewPoint[];
}

/**
 * Parse the LLM's JSON output. Tolerant of stray ```json fences and
 * surrounding prose. Returns null when the response isn't a JSON object
 * with at least one of the expected arrays.
 */
export function parseCurationResponse(raw: string): ParsedCuration | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const updates: ParsedUpdate[] = [];
  const newPoints: ParsedNewPoint[] = [];

  if (Array.isArray(obj['updates'])) {
    for (const u of obj['updates'] as unknown[]) {
      if (!u || typeof u !== 'object') continue;
      const r = u as Record<string, unknown>;
      const targetChunkId = typeof r['targetChunkId'] === 'string' ? r['targetChunkId'].trim() : '';
      const kind = sanitizeKind(r['kind']);
      const gist = typeof r['gist'] === 'string' ? r['gist'].trim().slice(0, 200) : '';
      const proposedText = typeof r['proposedText'] === 'string' ? r['proposedText'].trim() : '';
      if (!targetChunkId || !kind || !gist || !proposedText) continue;
      updates.push({ targetChunkId, kind, gist, proposedText });
    }
  }
  if (Array.isArray(obj['newPoints'])) {
    for (const n of obj['newPoints'] as unknown[]) {
      if (!n || typeof n !== 'object') continue;
      const r = n as Record<string, unknown>;
      const kind = sanitizeKind(r['kind']);
      const gist = typeof r['gist'] === 'string' ? r['gist'].trim().slice(0, 200) : '';
      const chunkText = typeof r['chunkText'] === 'string' ? r['chunkText'].trim() : '';
      if (!kind || !gist || !chunkText) continue;
      newPoints.push({ kind, gist, chunkText });
    }
  }

  if (updates.length === 0 && newPoints.length === 0) {
    return { updates, newPoints }; // valid empty report
  }
  return { updates, newPoints };
}

function sanitizeKind(raw: unknown): KnowledgeChunkKind | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase().replace(/-/g, '_');
  return KIND_SET.has(lower as KnowledgeChunkKind) ? (lower as KnowledgeChunkKind) : null;
}

/**
 * Best-effort JSON object extraction from a chat-style response. Strips
 * leading "Here is the report:" / trailing commentary / ```json fences.
 */
function extractJsonObject(raw: string): string | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1]!.trim();
  const openBrace = raw.indexOf('{');
  const closeBrace = raw.lastIndexOf('}');
  if (openBrace === -1 || closeBrace === -1 || closeBrace <= openBrace) return null;
  return raw.slice(openBrace, closeBrace + 1);
}

function buildCandidate(input: {
  hostSessionId: string;
  roleId: string;
  now: string;
  text: string;
  gist: string;
  kind: KnowledgeChunkKind;
  targetChunkId?: string;
}): KnowledgeCandidate {
  const textHash = createHash('sha256').update(input.text).digest('hex');
  const c: KnowledgeCandidate = {
    id: randomUUID(),
    roleId: input.roleId,
    hostSessionId: input.hostSessionId,
    chunkText: input.text,
    sourceSegmentIndex: 0,
    kind: input.kind,
    scoreEntity: 0,
    scoreCosine: 0,
    textHash,
    status: 'pending',
    createdAt: input.now,
    provenance: 'chat_capture',
    gist: input.gist,
  };
  if (input.targetChunkId) c.targetChunkId = input.targetChunkId;
  return c;
}
