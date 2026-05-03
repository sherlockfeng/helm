/**
 * sessionStart context aggregator — see PROJECT_BLUEPRINT.md §11.5.5.
 *
 * Pipeline for a host_session_start event:
 *   1. Build KnowledgeContext { hostSessionId, cwd }
 *   2. Run every enabled provider's canHandle in parallel; total budget 200ms
 *      (slow providers are dropped, not awaited)
 *   3. For canHandle=true providers, run getSessionContext in parallel; per-
 *      provider budget 5s
 *   4. Concatenate hits in registry-iteration order, prefixing each with a
 *      `## <displayName>` header
 *   5. Cap the total at 8KB (default); truncation drops trailing providers
 *      so the most-likely-relevant providers (registered first) win
 *
 * Failures and timeouts never throw — partial context is preferable to none.
 */

import type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeProviderRegistry,
} from './types.js';
import { DEFAULT_TIMEOUTS, SESSION_CONTEXT_MAX_BYTES } from '../constants.js';

export interface AggregateOptions {
  /** Total budget for the canHandle race. Defaults to constants.DEFAULT_TIMEOUTS.knowledgeCanHandleTotalMs. */
  canHandleTotalMs?: number;
  /** Per-provider budget for getSessionContext. Defaults to constants.DEFAULT_TIMEOUTS.knowledgeGetContextMs. */
  getContextTimeoutMs?: number;
  /** Cap the joined output at this many bytes (UTF-8). Defaults to constants.SESSION_CONTEXT_MAX_BYTES. */
  maxBytes?: number;
  /** Optional warning sink for slow / failing providers. Phase 8 logger plugs in. */
  onWarning?: (msg: string, ctx: { provider: string; phase: 'canHandle' | 'getSessionContext'; reason: string }) => void;
}

export interface AggregateDiagnostic {
  provider: string;
  phase: 'canHandle' | 'getSessionContext';
  status: 'ok' | 'skipped' | 'error' | 'timeout' | 'truncated';
  bytes?: number;
  reason?: string;
}

export interface AggregateResult {
  /** Markdown ready to drop into hook response's additional_context. */
  context: string;
  diagnostics: AggregateDiagnostic[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ value?: T; timedOut?: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
  return Promise.race([
    p.then((value) => ({ value })),
    timeout,
  ]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<{ value?: T; timedOut?: true }>;
}

async function safeCanHandle(
  provider: KnowledgeProvider,
  ctx: KnowledgeContext,
  totalDeadline: number,
): Promise<{ provider: KnowledgeProvider; hit: boolean; reason?: string; timedOut?: boolean }> {
  const remaining = Math.max(0, totalDeadline - Date.now());
  // Wrap call in (async () => ...)() so a synchronous throw becomes a
  // rejected promise, not an exception during Promise.resolve.
  const inner = (async () => provider.canHandle(ctx))();
  try {
    const result = await withTimeout(inner, remaining);
    if (result.timedOut) return { provider, hit: false, timedOut: true, reason: 'canHandle exceeded total budget' };
    return { provider, hit: Boolean(result.value) };
  } catch (err) {
    return { provider, hit: false, reason: (err as Error).message };
  }
}

async function safeGetSessionContext(
  provider: KnowledgeProvider,
  ctx: KnowledgeContext,
  perProviderMs: number,
): Promise<{ provider: KnowledgeProvider; markdown?: string; reason?: string; timedOut?: boolean }> {
  try {
    const result = await withTimeout(provider.getSessionContext(ctx), perProviderMs);
    if (result.timedOut) return { provider, timedOut: true, reason: `getSessionContext timed out after ${perProviderMs}ms` };
    if (result.value === null || result.value === undefined) return { provider };
    return { provider, markdown: String(result.value) };
  } catch (err) {
    return { provider, reason: (err as Error).message };
  }
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export async function aggregateSessionContext(
  registry: KnowledgeProviderRegistry,
  ctx: KnowledgeContext,
  options: AggregateOptions = {},
): Promise<AggregateResult> {
  const canHandleTotalMs = options.canHandleTotalMs ?? DEFAULT_TIMEOUTS.knowledgeCanHandleTotalMs;
  const getContextTimeoutMs = options.getContextTimeoutMs ?? DEFAULT_TIMEOUTS.knowledgeGetContextMs;
  const maxBytes = options.maxBytes ?? SESSION_CONTEXT_MAX_BYTES;
  const warn = options.onWarning ?? (() => {});

  const providers = registry.list();
  const diagnostics: AggregateDiagnostic[] = [];
  if (providers.length === 0) return { context: '', diagnostics };

  // Phase 1: canHandle race
  const canHandleDeadline = Date.now() + canHandleTotalMs;
  const canHandleResults = await Promise.all(
    providers.map((p) => safeCanHandle(p, ctx, canHandleDeadline)),
  );

  const handlers: KnowledgeProvider[] = [];
  for (const r of canHandleResults) {
    if (r.timedOut) {
      diagnostics.push({ provider: r.provider.id, phase: 'canHandle', status: 'timeout', reason: r.reason });
      warn('canHandle timeout', { provider: r.provider.id, phase: 'canHandle', reason: r.reason ?? 'timeout' });
    } else if (r.reason) {
      diagnostics.push({ provider: r.provider.id, phase: 'canHandle', status: 'error', reason: r.reason });
      warn('canHandle error', { provider: r.provider.id, phase: 'canHandle', reason: r.reason });
    } else if (!r.hit) {
      diagnostics.push({ provider: r.provider.id, phase: 'canHandle', status: 'skipped' });
    } else {
      handlers.push(r.provider);
    }
  }

  if (handlers.length === 0) return { context: '', diagnostics };

  // Phase 2: getSessionContext race (per-provider budget)
  const sessionResults = await Promise.all(
    handlers.map((p) => safeGetSessionContext(p, ctx, getContextTimeoutMs)),
  );

  // Phase 3: concatenate in registry order, with per-section header + cap
  const parts: string[] = [];
  let total = 0;
  // Preserve registry iteration order: handlers were sorted by their position
  // in providers, but Promise.all preserves input order, so this is fine.
  for (const r of sessionResults) {
    if (r.reason && r.timedOut) {
      diagnostics.push({ provider: r.provider.id, phase: 'getSessionContext', status: 'timeout', reason: r.reason });
      warn('getSessionContext timeout', { provider: r.provider.id, phase: 'getSessionContext', reason: r.reason });
      continue;
    }
    if (r.reason) {
      diagnostics.push({ provider: r.provider.id, phase: 'getSessionContext', status: 'error', reason: r.reason });
      warn('getSessionContext error', { provider: r.provider.id, phase: 'getSessionContext', reason: r.reason });
      continue;
    }
    if (!r.markdown) continue;

    const block = `## ${r.provider.displayName}\n${r.markdown}`;
    const blockBytes = utf8Bytes(block);
    if (total + blockBytes > maxBytes) {
      diagnostics.push({ provider: r.provider.id, phase: 'getSessionContext', status: 'truncated', bytes: blockBytes });
      // Stop accumulating — earliest providers (registered first) win the budget.
      continue;
    }
    parts.push(block);
    total += blockBytes + (parts.length > 1 ? 2 : 0); // separator newlines
    diagnostics.push({ provider: r.provider.id, phase: 'getSessionContext', status: 'ok', bytes: blockBytes });
  }

  return { context: parts.join('\n\n'), diagnostics };
}
