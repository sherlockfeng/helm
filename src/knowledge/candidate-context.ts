/**
 * Candidate external context (knowledge tiers PR-β).
 *
 * "对话里找到知识点后，用外部知识源查一下，一起展示出来" — when capture
 * inserts a candidate, helm immediately queries the configured external
 * providers (custom MCP bridges like the user's knowledge platform,
 * depscope, …) with the fragment text in the background and caches the
 * answer. By the time the user opens the Review inbox, the org-side
 * context is already sitting next to the chat-captured fragment — no
 * button, no on-page round-trip.
 *
 * The cache is one row per candidate (latest fetch wins). Rows cascade
 * away with the candidate. A refresh endpoint re-runs the fetch on
 * demand (provider config changed, transient failure, …).
 */

import type Database from 'better-sqlite3';
import { queryKnowledge } from '../mcp/tools/query-knowledge.js';
import type { KnowledgeProviderRegistry } from './types.js';

export interface CandidateExternalContext {
  candidateId: string;
  /** Provider ids that contributed, in snippet order. */
  providers: string[];
  /** Merged display body — each snippet prefixed with its source id. */
  body: string;
  fetchedAt: number;
}

/** Query length cap — external RAG backends choke on whole transcripts. */
const MAX_QUERY_CHARS = 300;
const FETCH_TIMEOUT_MS = 20_000;

export function getCandidateContext(
  db: Database.Database,
  candidateId: string,
): CandidateExternalContext | undefined {
  const row = db.prepare(
    `SELECT candidate_id, providers, body, fetched_at
       FROM candidate_external_context WHERE candidate_id = ?`,
  ).get(candidateId) as Record<string, unknown> | undefined;
  return row ? rowToContext(row) : undefined;
}

export function getCandidateContexts(
  db: Database.Database,
  candidateIds: readonly string[],
): Record<string, CandidateExternalContext> {
  const out: Record<string, CandidateExternalContext> = {};
  if (candidateIds.length === 0) return out;
  const stmt = db.prepare(
    `SELECT candidate_id, providers, body, fetched_at
       FROM candidate_external_context WHERE candidate_id = ?`,
  );
  for (const id of candidateIds) {
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (row) out[id] = rowToContext(row);
  }
  return out;
}

function rowToContext(row: Record<string, unknown>): CandidateExternalContext {
  let providers: string[] = [];
  try {
    const parsed = JSON.parse(String(row['providers'])) as unknown;
    if (Array.isArray(parsed)) {
      providers = parsed.filter((p): p is string => typeof p === 'string');
    }
  } catch { /* tolerate malformed rows — body still renders */ }
  return {
    candidateId: String(row['candidate_id']),
    providers,
    body: String(row['body']),
    fetchedAt: Number(row['fetched_at']),
  };
}

/**
 * Fetch external context for one candidate and cache it. Returns the
 * stored row, or null when every provider came back empty/failed —
 * in that case nothing is cached so a later refresh retries cleanly.
 *
 * Never throws: this runs fire-and-forget after capture, and on the
 * refresh endpoint where the HTTP layer maps null to "no context".
 */
export async function fetchAndCacheCandidateContext(
  db: Database.Database,
  registry: KnowledgeProviderRegistry,
  input: {
    candidateId: string;
    queryText: string;
    /** Provider ids to ask. Empty/absent = every registered provider. */
    providers?: readonly string[];
    onWarning?: (msg: string, ctx: Record<string, unknown>) => void;
  },
): Promise<CandidateExternalContext | null> {
  const query = input.queryText.slice(0, MAX_QUERY_CHARS).trim();
  if (!query) return null;
  try {
    const result = await queryKnowledge(
      registry,
      {
        query,
        ...(input.providers && input.providers.length > 0
          ? { providers: [...input.providers] } : {}),
      },
      { searchTimeoutMs: FETCH_TIMEOUT_MS },
    );
    const snippets = result.snippets.filter((s) => s.body.trim().length > 0);
    if (snippets.length === 0) return null;
    const providers = [...new Set(snippets.map((s) => s.source))];
    const body = snippets
      .map((s) => `【${s.source}】\n${s.body.trim()}`)
      .join('\n\n');
    const fetchedAt = Date.now();
    db.prepare(`
      INSERT INTO candidate_external_context (candidate_id, providers, body, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        providers = excluded.providers,
        body = excluded.body,
        fetched_at = excluded.fetched_at
    `).run(input.candidateId, JSON.stringify(providers), body, fetchedAt);
    return { candidateId: input.candidateId, providers, body, fetchedAt };
  } catch (err) {
    input.onWarning?.('candidate_context_fetch_failed', {
      candidateId: input.candidateId,
      message: (err as Error).message,
    });
    return null;
  }
}
