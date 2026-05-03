/**
 * MCP tool: list_knowledge_providers
 *
 * Returns the providers an agent can ask via query_knowledge, plus their
 * current health. Per PROJECT_BLUEPRINT.md §13.2.
 *
 * Healthcheck calls run in parallel with a per-provider timeout — a slow
 * provider must not block the response.
 */

import type { KnowledgeProvider, KnowledgeProviderRegistry } from '../../knowledge/types.js';
import { DEFAULT_TIMEOUTS } from '../../constants.js';

export interface ProviderEntry {
  id: string;
  displayName: string;
  healthy: boolean;
  reason?: string;
}

export interface ListKnowledgeProvidersResult {
  providers: ProviderEntry[];
}

export interface ListKnowledgeProvidersOptions {
  /** Override the per-provider healthcheck timeout. Defaults to 5s. */
  healthcheckTimeoutMs?: number;
}

async function checkProvider(
  provider: KnowledgeProvider,
  timeoutMs: number,
): Promise<ProviderEntry> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `healthcheck timed out after ${timeoutMs}ms` }), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([provider.healthcheck(), timeout]);
    return {
      id: provider.id,
      displayName: provider.displayName,
      healthy: result.ok,
      reason: result.reason,
    };
  } catch (err) {
    return {
      id: provider.id,
      displayName: provider.displayName,
      healthy: false,
      reason: (err as Error).message,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listKnowledgeProviders(
  registry: KnowledgeProviderRegistry,
  options: ListKnowledgeProvidersOptions = {},
): Promise<ListKnowledgeProvidersResult> {
  const timeoutMs = options.healthcheckTimeoutMs ?? DEFAULT_TIMEOUTS.knowledgeGetContextMs;
  const entries = await Promise.all(
    registry.list().map((p) => checkProvider(p, timeoutMs)),
  );
  return { providers: entries };
}
