/**
 * KnowledgeProvider abstraction — see PROJECT_BLUEPRINT.md §11.5.
 *
 * v1 surface area is intentionally minimal: providers are pluggable, identified
 * by id, and answer two questions:
 *   1. canHandle(ctx) — should I be consulted?
 *   2. getSessionContext / search — what context can I provide?
 *
 * Phase 6 ships only the types + a `KnowledgeProviderRegistry` so the MCP
 * `query_knowledge` / `list_knowledge_providers` tools have something to dispatch
 * against. Phase 7.5 lands LocalRolesProvider; Phase 13 lands DepscopeProvider.
 */

export interface KnowledgeContext {
  hostSessionId: string;
  cwd: string;
  filePath?: string;
}

export interface KnowledgeSnippet {
  /** Provider id this snippet came from. */
  source: string;
  title: string;
  body: string;
  score?: number;
  citation?: string;
}

export interface KnowledgeProviderHealth {
  ok: boolean;
  reason?: string;
}

export interface KnowledgeProvider {
  readonly id: string;
  readonly displayName: string;

  /** Whether this provider should be consulted for the given context. */
  canHandle(ctx: KnowledgeContext): boolean | Promise<boolean>;

  /** Markdown context to inject into the host's session_start additional_context. */
  getSessionContext(ctx: KnowledgeContext): Promise<string | null>;

  /** Agent / UI explicit query. Aggregator combines results across providers. */
  search(query: string, ctx?: KnowledgeContext): Promise<KnowledgeSnippet[]>;

  /** Settings page status indicator. */
  healthcheck(): Promise<KnowledgeProviderHealth>;
}

/**
 * In-process registry of KnowledgeProviders. The MCP tools and the sessionStart
 * hook injection both use this to enumerate / dispatch.
 *
 * Order is preserved (insertion order). Phase 7.5's aggregator will sort by
 * score within a query result; this registry just holds references.
 */
export class KnowledgeProviderRegistry {
  private readonly providers = new Map<string, KnowledgeProvider>();

  register(provider: KnowledgeProvider): void {
    if (!provider.id) throw new Error('KnowledgeProvider must have an id');
    if (this.providers.has(provider.id)) {
      throw new Error(`KnowledgeProvider with id "${provider.id}" already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): KnowledgeProvider | undefined {
    return this.providers.get(id);
  }

  list(): KnowledgeProvider[] {
    return [...this.providers.values()];
  }

  size(): number {
    return this.providers.size;
  }
}
