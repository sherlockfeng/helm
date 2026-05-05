/**
 * DepscopeProvider — reference implementation of a remote KnowledgeProvider
 * that pulls dependency / SCM context from a depscope-style endpoint.
 *
 * Per PROJECT_BLUEPRINT.md §11.5: cwd is matched against `mappings[].cwdPrefix`
 * to resolve the project's `scmName`. The provider then fetches both
 * sessionContext markdown and search snippets from the endpoint scoped to
 * that scmName.
 *
 * Endpoint contract (HTTP / JSON):
 *
 *   GET  /api/v1/health
 *        → { ok: boolean, reason?: string }
 *
 *   GET  /api/v1/sessions?scm=<name>&filePath=<optional>
 *        → { markdown: string } | 404
 *
 *   GET  /api/v1/search?q=<query>&scm=<optional>
 *        → { snippets: Array<{ title, body, score?, citation? }> }
 *
 * Auth: Bearer token via `Authorization: Bearer <authToken>` (when configured).
 *
 * Failure modes never throw at the provider boundary — the aggregator and
 * MCP tools already isolate per-provider failures, but this module
 * additionally:
 *   - caches successful sessionContext (default 5min TTL) so transient
 *     network blips don't visibly stall sessionStart
 *   - times out individual requests (default 5s)
 *   - returns null / empty on non-2xx, JSON parse error, fetch reject
 */

import { longestPrefixMatch } from './match.js';
import type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeProviderHealth,
  KnowledgeSnippet,
} from './types.js';

export interface DepscopeMapping {
  /** Path prefix that scopes a chat into this mapping. Tilde-expansion supported. */
  cwdPrefix: string;
  /** The provider-scoped identifier passed to depscope as `?scm=<name>`. */
  scmName: string;
}

export interface DepscopeProviderOptions {
  endpoint: string;
  authToken?: string;
  mappings: readonly DepscopeMapping[];

  /** Override for tests + mocking; defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Cache TTL for getSessionContext per (scmName, filePath). Default 5 min. */
  cacheTtlMs?: number;
  /** Per-request timeout. Default 5 s. */
  requestTimeoutMs?: number;
  /** Optional logger sink for unexpected failures. Defaults to no-op. */
  onWarning?: (msg: string, ctx: Record<string, unknown>) => void;
}

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export class DepscopeProvider implements KnowledgeProvider {
  readonly id = 'depscope';
  readonly displayName = 'Depscope';

  private readonly endpoint: string;
  private readonly authToken?: string;
  private readonly mappings: readonly DepscopeMapping[];
  private readonly fetchFn: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onWarning: (msg: string, ctx: Record<string, unknown>) => void;
  private readonly sessionCache = new Map<string, CacheEntry>();

  constructor(options: DepscopeProviderOptions) {
    if (!options.endpoint) throw new Error('DepscopeProvider requires an endpoint');
    // Strip trailing slash so we can interpolate `${endpoint}/api/...` cleanly.
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.authToken = options.authToken;
    this.mappings = options.mappings;
    this.fetchFn = options.fetchFn ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onWarning = options.onWarning ?? (() => {});
  }

  canHandle(ctx: KnowledgeContext): boolean {
    return longestPrefixMatch(ctx.cwd, this.mappings) !== null;
  }

  async getSessionContext(ctx: KnowledgeContext): Promise<string | null> {
    const mapping = longestPrefixMatch(ctx.cwd, this.mappings);
    if (!mapping) return null;

    const cacheKey = `${mapping.scmName}|${ctx.filePath ?? ''}`;
    const cached = this.sessionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const url = this.url('/api/v1/sessions', {
      scm: mapping.scmName,
      ...(ctx.filePath ? { filePath: ctx.filePath } : {}),
    });

    const result = await this.tryFetch(url, 'getSessionContext');
    if (!result) {
      // Cache misses are NOT cached — we want to retry on the next call so
      // a recovered endpoint surfaces context promptly.
      return null;
    }

    let markdown: string | null = null;
    try {
      const parsed = (await result.json()) as { markdown?: unknown };
      markdown = typeof parsed.markdown === 'string' ? parsed.markdown : null;
    } catch (err) {
      this.onWarning('json_parse_error', { url, error: (err as Error).message });
      return null;
    }

    this.sessionCache.set(cacheKey, {
      value: markdown,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return markdown;
  }

  async search(query: string, ctx?: KnowledgeContext): Promise<KnowledgeSnippet[]> {
    if (!query.trim()) return [];

    // Scope to the current chat's mapping when context is available; otherwise
    // hit the endpoint un-scoped (depscope decides whether to refuse).
    const mapping = ctx ? longestPrefixMatch(ctx.cwd, this.mappings) : null;
    const url = this.url('/api/v1/search', {
      q: query,
      ...(mapping ? { scm: mapping.scmName } : {}),
    });

    const result = await this.tryFetch(url, 'search');
    if (!result) return [];

    try {
      const parsed = (await result.json()) as { snippets?: unknown };
      if (!Array.isArray(parsed.snippets)) return [];
      return parsed.snippets
        .filter((s): s is { title: unknown; body: unknown } =>
          Boolean(s) && typeof s === 'object')
        .map((raw) => {
          const r = raw as Record<string, unknown>;
          return {
            source: this.id,
            title: typeof r['title'] === 'string' ? r['title'] : 'Untitled',
            body: typeof r['body'] === 'string' ? r['body'] : '',
            score: typeof r['score'] === 'number' ? r['score'] : undefined,
            citation: typeof r['citation'] === 'string' ? r['citation'] : undefined,
          };
        });
    } catch (err) {
      this.onWarning('json_parse_error', { url, error: (err as Error).message });
      return [];
    }
  }

  async healthcheck(): Promise<KnowledgeProviderHealth> {
    const url = this.url('/api/v1/health');
    const result = await this.tryFetch(url, 'healthcheck');
    if (!result) {
      return { ok: false, reason: 'unreachable' };
    }
    try {
      const parsed = (await result.json()) as { ok?: unknown; reason?: unknown };
      const ok = parsed.ok === true;
      return ok
        ? { ok: true }
        : { ok: false, reason: typeof parsed.reason === 'string' ? parsed.reason : 'endpoint reported unhealthy' };
    } catch (err) {
      return { ok: false, reason: `parse error: ${(err as Error).message}` };
    }
  }

  /**
   * Test seam — drop the cache so a follow-up call refreshes from the endpoint.
   * Useful when the user clicks "reload" in Settings or rotates auth tokens.
   */
  clearCache(): void {
    this.sessionCache.clear();
  }

  // ── private ────────────────────────────────────────────────────────────

  private url(path: string, params?: Record<string, string>): string {
    const u = new URL(`${this.endpoint}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  private async tryFetch(url: string, phase: string): Promise<Response | null> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    timer.unref?.();

    try {
      const res = await this.fetchFn(url, { headers, signal: ac.signal });
      if (!res.ok) {
        this.onWarning('non_2xx', { phase, url, status: res.status });
        return null;
      }
      return res;
    } catch (err) {
      const isAbort = (err as { name?: string }).name === 'AbortError';
      this.onWarning(isAbort ? 'timeout' : 'fetch_error', {
        phase, url, error: (err as Error).message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
