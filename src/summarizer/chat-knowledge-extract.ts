/**
 * LLM chat-level knowledge extraction (v35).
 *
 * Reads a whole conversation and asks the LLM for concrete, durable
 * knowledge points — each routed to a home topic: an existing one (matched
 * by id from the topic list we pass in) or a proposed NEW topic name. This
 * replaces the deterministic entity-token surfaces ("HELM 不认识的内容" /
 * "这条对话涉及") with a semantic pass.
 *
 * Best-effort: any LLM/parse failure leaves the DB untouched and returns 0.
 * Throttled by the caller (Stop hook, once turns accumulate) or forced via
 * the manual extract endpoint.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { LlmClient } from './campaign.js';
import { listRoles } from '../storage/repos/roles.js';
import { listHostEvents } from '../storage/repos/host-event-log.js';
import { groupEventsIntoTurns } from '../api/conversation-detail.js';
import {
  insertChatKnowledgePoint,
  type ChatKnowledgeKind,
} from '../storage/repos/chat-knowledge.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 2500;
const MAX_CHAT_CHARS = 16_000;
const KINDS: ReadonlySet<ChatKnowledgeKind> = new Set(
  ['spec', 'example', 'warning', 'runbook', 'glossary', 'other'],
);

export interface ExtractDeps {
  llm: LlmClient;
  model?: string;
  maxTokens?: number;
}

export interface ExtractResult {
  /** Newly inserted points (deduped against existing pending/dismissed). */
  inserted: number;
}

export async function extractChatKnowledge(
  db: Database.Database,
  hostSessionId: string,
  deps: ExtractDeps,
): Promise<ExtractResult> {
  const events = listHostEvents(db, hostSessionId, { limit: 500 });
  const turns = groupEventsIntoTurns(events);
  if (turns.length === 0) return { inserted: 0 };

  // Existing topics the LLM can route a point into. bindable + plain both
  // count; we pass id+name so the model returns a concrete id when one fits.
  const topics = listRoles(db).map((r) => ({ id: r.id, name: r.name }));

  const prompt = buildPrompt(topics, renderChat(turns));
  let raw: string;
  try {
    raw = await deps.llm.generate(prompt, {
      model: deps.model ?? DEFAULT_MODEL,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  } catch { return { inserted: 0 }; }

  const points = parsePoints(raw, new Set(topics.map((t) => t.id)));
  const now = new Date().toISOString();
  let inserted = 0;
  for (const p of points) {
    const ok = insertChatKnowledgePoint(db, {
      id: randomUUID(),
      hostSessionId,
      title: p.title,
      body: p.body,
      kind: p.kind,
      suggestedRoleId: p.suggestedRoleId,
      suggestedTopicName: p.suggestedTopicName,
      createdAt: now,
    });
    if (ok) inserted += 1;
  }
  return { inserted };
}

// ── prompt ──────────────────────────────────────────────────────────────

function renderChat(
  turns: ReadonlyArray<{ userPrompt: { text: string }; assistantResponse?: { text: string } }>,
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

function truncate(s: string, cap: number): string {
  const t = s.trim();
  return t.length <= cap ? t : `${t.slice(0, cap)}…[truncated]`;
}

function buildPrompt(topics: { id: string; name: string }[], chatBlob: string): string {
  const topicList = topics.length === 0
    ? '(no topics yet — every point will propose a new topic)'
    : topics.map((t) => `[${t.id}] ${t.name}`).join('\n');
  return [
    'You extract durable, reusable KNOWLEDGE POINTS from a developer conversation,',
    'and route each to a home "topic" (a knowledge collection).',
    '',
    'Existing topics (id + name):',
    topicList,
    '',
    'Conversation:',
    '---',
    chatBlob,
    '---',
    '',
    'Return ONLY JSON — no preamble — shaped like:',
    '{',
    '  "points": [',
    '    {',
    '      "title": "<short headline in the chat\'s language, ≤80 chars>",',
    '      "body": "<the knowledge as a self-contained note, markdown OK>",',
    '      "kind": "spec|example|warning|runbook|glossary|other",',
    '      "topicId": "<an id from the list above if one clearly fits, else null>",',
    '      "newTopic": "<a short new topic name if no existing topic fits, else null>"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- A knowledge point is a DURABLE fact/decision/how-to worth reusing later —',
    '  NOT chat scaffolding (questions, plans, status, apologies, tool output).',
    '- Prefer routing to an existing topicId when one clearly fits; only set',
    '  newTopic when none does. Set exactly one of topicId / newTopic per point.',
    '- Use the conversation\'s own language (Chinese chat → Chinese title/body).',
    '- Merge duplicates; emit each distinct point once.',
    '- Return {"points": []} if nothing is worth keeping. Quality over quantity.',
  ].join('\n');
}

// ── parse ───────────────────────────────────────────────────────────────

interface ParsedPoint {
  title: string;
  body: string;
  kind: ChatKnowledgeKind;
  suggestedRoleId: string | null;
  suggestedTopicName: string | null;
}

export function parsePoints(raw: string, validTopicIds: ReadonlySet<string>): ParsedPoint[] {
  const json = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const arr = (parsed as Record<string, unknown>)['points'];
  if (!Array.isArray(arr)) return [];

  const out: ParsedPoint[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r['title'] === 'string' ? r['title'].trim().slice(0, 120) : '';
    const body = typeof r['body'] === 'string' ? r['body'].trim() : '';
    if (!title || !body) continue;
    const kind = sanitizeKind(r['kind']);
    // Route: prefer a valid existing id; else a non-empty new-topic name.
    const topicId = typeof r['topicId'] === 'string' && validTopicIds.has(r['topicId'])
      ? r['topicId'] : null;
    const newTopic = !topicId && typeof r['newTopic'] === 'string' && r['newTopic'].trim()
      ? r['newTopic'].trim().slice(0, 60) : null;
    out.push({ title, body, kind, suggestedRoleId: topicId, suggestedTopicName: newTopic });
  }
  return out;
}

function sanitizeKind(raw: unknown): ChatKnowledgeKind {
  if (typeof raw !== 'string') return 'other';
  const k = raw.trim().toLowerCase();
  return KINDS.has(k as ChatKnowledgeKind) ? (k as ChatKnowledgeKind) : 'other';
}

function extractJsonObject(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1]!.trim();
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open === -1 || close === -1 || close <= open) return null;
  return raw.slice(open, close + 1);
}
