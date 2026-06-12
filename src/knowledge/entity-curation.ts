/**
 * LLM curation of the unknown-entity suggestion strip.
 *
 * Rule extraction (extractEntities tiers) surfaces tokens no regex can
 * judge: usernames from paths ('heyunfeng'), generic platform words
 * ('github'), code identifiers. The user asked for an agent to pick —
 * so at the Stop hook (same site as the chat TL;DR) helm hands the
 * strip to the configured engine once and caches its verdict.
 *
 * Cache semantics ("monotone filter"):
 *   - entities the LLM SAW and rejected → hidden
 *   - entities the LLM SAW and kept     → shown
 *   - entities it has NOT seen yet (appeared after the last pass) →
 *     shown unfiltered until the next Stop re-curates
 * Same input hash → no repeat LLM call.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LlmClient } from '../summarizer/campaign.js';
import { unknownEntitiesForChat, type UnknownEntity } from './chat-unknown-entities.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 400;

export interface EntityCuration {
  hostSessionId: string;
  inputHash: string;
  /** Entity names (original casing) the LLM was shown. */
  inputEntities: string[];
  /** Subset the LLM judged to be real knowledge entities. */
  kept: string[];
  curatedAt: number;
}

export function getEntityCuration(
  db: Database.Database,
  hostSessionId: string,
): EntityCuration | undefined {
  const row = db.prepare(
    `SELECT host_session_id, input_hash, input_entities, kept, curated_at
       FROM chat_entity_curation WHERE host_session_id = ?`,
  ).get(hostSessionId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    hostSessionId: String(row['host_session_id']),
    inputHash: String(row['input_hash']),
    inputEntities: parseStringArray(row['input_entities']),
    kept: parseStringArray(row['kept']),
    curatedAt: Number(row['curated_at']),
  };
}

function parseStringArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Monotone filter: drop entities the LLM saw and rejected; pass
 * everything else (kept + unseen-since-curation). Pure — unit-testable
 * without an LLM.
 */
export function applyCuration(
  unknowns: UnknownEntity[],
  curation: EntityCuration | undefined,
): UnknownEntity[] {
  if (!curation) return unknowns;
  const seen = new Set(curation.inputEntities.map((e) => e.toLowerCase()));
  const kept = new Set(curation.kept.map((e) => e.toLowerCase()));
  return unknowns.filter((u) => {
    const key = u.entity.toLowerCase();
    return !seen.has(key) || kept.has(key);
  });
}

export function hashEntities(unknowns: readonly UnknownEntity[]): string {
  const canonical = [...unknowns]
    .map((u) => `${u.entity.toLowerCase()}:${u.mentions}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export interface CurateDeps {
  llm: LlmClient;
  model?: string;
}

/**
 * Run (or skip) the curation pass for one chat. Fire-and-forget from
 * the Stop hook — returns the kept list on a fresh pass, null when
 * skipped (no entities / cache fresh / LLM failure).
 */
export async function curateChatEntities(
  db: Database.Database,
  hostSessionId: string,
  deps: CurateDeps,
): Promise<string[] | null> {
  const unknowns = unknownEntitiesForChat(db, hostSessionId);
  if (unknowns.length === 0) return null;

  const inputHash = hashEntities(unknowns);
  const existing = getEntityCuration(db, hostSessionId);
  if (existing && existing.inputHash === inputHash) return null;

  const listing = unknowns.map((u) => `${u.entity} ×${u.mentions}`).join('\n');
  const prompt = [
    '下面是从一段技术对话里规则提取出来的高频 token（带出现次数）。',
    '挑出真正代表"值得沉淀知识的技术实体 / 领域概念"的 token。',
    '排除：人名或账号名、PR/issue/工单编号、通用平台或工具名（如 github、npm）、',
    '路径或文件名的碎片、普通英文单词、UI 文案。',
    '只输出一个 JSON 数组（保持原 token 写法），不要任何其他文字。例如：["SSO","ETL"]',
    '',
    listing,
  ].join('\n');

  let raw: string;
  try {
    raw = await deps.llm.generate(prompt, {
      model: deps.model ?? DEFAULT_MODEL,
      maxTokens: MAX_TOKENS,
    });
  } catch {
    return null;
  }

  const kept = parseKeptList(raw, unknowns.map((u) => u.entity));
  if (kept === null) return null;

  db.prepare(`
    INSERT INTO chat_entity_curation
      (host_session_id, input_hash, input_entities, kept, curated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(host_session_id) DO UPDATE SET
      input_hash = excluded.input_hash,
      input_entities = excluded.input_entities,
      kept = excluded.kept,
      curated_at = excluded.curated_at
  `).run(
    hostSessionId,
    inputHash,
    JSON.stringify(unknowns.map((u) => u.entity)),
    JSON.stringify(kept),
    Date.now(),
  );
  return kept;
}

/**
 * Tolerant parse: strip code fences, find the first JSON array, keep
 * only names that were actually in the input (the LLM must select, not
 * invent). Returns null when no array can be recovered — we'd rather
 * skip caching than cache garbage that hides everything.
 */
export function parseKeptList(raw: string, inputNames: readonly string[]): string[] | null {
  const m = raw.replace(/```[a-z]*\n?/gi, '').match(/\[[\s\S]*?\]/);
  if (!m) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const byLower = new Map(inputNames.map((n) => [n.toLowerCase(), n]));
  const kept: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const canonical = byLower.get(item.toLowerCase());
    if (canonical && !kept.includes(canonical)) kept.push(canonical);
  }
  return kept;
}
