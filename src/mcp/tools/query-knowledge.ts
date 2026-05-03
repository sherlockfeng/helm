/**
 * MCP tool: query_knowledge
 *
 * Aggregates KnowledgeProvider.search across all enabled providers (or a
 * caller-specified subset), merges results, and returns snippets sorted by
 * score descending.
 *
 * Per PROJECT_BLUEPRINT.md §13.2 + §11.5.
 *
 * Failure modes:
 *   - Provider's canHandle is consulted first; non-handling providers are skipped silently
 *   - search() that throws or times out yields zero snippets for that provider; others continue
 *   - Aggregator never throws — partial results are always preferable to none
 */

import type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeProviderRegistry,
  KnowledgeSnippet,
} from '../../knowledge/types.js';
import { DEFAULT_TIMEOUTS } from '../../constants.js';

export interface QueryKnowledgeInput {
  query: string;
  hostSessionId?: string;
  cwd?: string;
  filePath?: string;
  /** Limit to a subset of provider ids; defaults to all registered. */
  providers?: string[];
}

export interface QueryKnowledgeResult {
  snippets: KnowledgeSnippet[];
  /** Per-provider status; useful for debugging "why is this empty". */
  diagnostics: Array<{
    provider: string;
    status: 'ok' | 'skipped' | 'error' | 'timeout';
    snippetCount: number;
    reason?: string;
  }>;
}

export interface QueryKnowledgeOptions {
  searchTimeoutMs?: number;
}

function buildContext(input: QueryKnowledgeInput): KnowledgeContext | undefined {
  if (!input.hostSessionId || !input.cwd) return undefined;
  return {
    hostSessionId: input.hostSessionId,
    cwd: input.cwd,
    filePath: input.filePath,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ value?: T; timedOut?: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      promise.then((value) => ({ value })),
      timeout,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function queryOne(
  provider: KnowledgeProvider,
  input: QueryKnowledgeInput,
  ctx: KnowledgeContext | undefined,
  searchTimeoutMs: number,
): Promise<{
  provider: string;
  status: 'ok' | 'skipped' | 'error' | 'timeout';
  snippets: KnowledgeSnippet[];
  reason?: string;
}> {
  if (ctx) {
    try {
      const handles = await provider.canHandle(ctx);
      if (!handles) {
        return { provider: provider.id, status: 'skipped', snippets: [], reason: 'canHandle returned false' };
      }
    } catch (err) {
      return { provider: provider.id, status: 'error', snippets: [], reason: `canHandle: ${(err as Error).message}` };
    }
  }

  try {
    const result = await withTimeout(provider.search(input.query, ctx), searchTimeoutMs);
    if (result.timedOut) {
      return { provider: provider.id, status: 'timeout', snippets: [], reason: `search timed out after ${searchTimeoutMs}ms` };
    }
    const snippets = result.value ?? [];
    return { provider: provider.id, status: 'ok', snippets };
  } catch (err) {
    return { provider: provider.id, status: 'error', snippets: [], reason: (err as Error).message };
  }
}

export async function queryKnowledge(
  registry: KnowledgeProviderRegistry,
  input: QueryKnowledgeInput,
  options: QueryKnowledgeOptions = {},
): Promise<QueryKnowledgeResult> {
  const searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_TIMEOUTS.knowledgeGetContextMs;
  const ctx = buildContext(input);

  const all = registry.list();
  const requestedSet = input.providers && input.providers.length > 0 ? new Set(input.providers) : null;
  const targets = requestedSet ? all.filter((p) => requestedSet.has(p.id)) : all;

  const perProvider = await Promise.all(targets.map((p) => queryOne(p, input, ctx, searchTimeoutMs)));

  const snippets: KnowledgeSnippet[] = [];
  const diagnostics: QueryKnowledgeResult['diagnostics'] = [];
  for (const r of perProvider) {
    diagnostics.push({
      provider: r.provider,
      status: r.status,
      snippetCount: r.snippets.length,
      reason: r.reason,
    });
    snippets.push(...r.snippets);
  }
  snippets.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return { snippets, diagnostics };
}
