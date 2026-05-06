/**
 * MCP stdio entry point.
 *
 * Cursor (and other MCP clients) spawn this when they need an MCP connection.
 * Wires DB + knowledge registry, then connects over stdio.
 *
 * KnowledgeProviderRegistry is pre-populated with LocalRolesProvider
 * (backed by the seeded built-in roles + user-trained custom roles), plus
 * any provider declared in `~/.helm/config.json` (DepscopeProvider today,
 * future wiki / SDK doc providers added without touching this file).
 */

import { HelmDB } from '../storage/database.js';
import { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { LocalRolesProvider } from '../knowledge/local-roles-provider.js';
import { DepscopeProvider } from '../knowledge/depscope-provider.js';
import { RequirementsArchiveProvider } from '../knowledge/requirements-archive-provider.js';
import { startMcpServer } from './server.js';
import { makePseudoEmbedFn } from './embed.js';
import { loadHelmConfig } from '../config/loader.js';
import { DepscopeProviderConfigSchema } from '../config/schema.js';

export async function main(): Promise<void> {
  const db = new HelmDB();
  const knowledge = new KnowledgeProviderRegistry();

  knowledge.register(new LocalRolesProvider({
    db: db.sqlite,
    embedFn: makePseudoEmbedFn(),
  }));
  knowledge.register(new RequirementsArchiveProvider());

  const { config } = loadHelmConfig();
  for (const decl of config.knowledge.providers) {
    if (!decl.enabled) continue;
    if (decl.id === 'depscope') {
      const parsed = DepscopeProviderConfigSchema.safeParse(decl.config ?? {});
      if (!parsed.success) continue;
      knowledge.register(new DepscopeProvider({
        endpoint: parsed.data.endpoint,
        authToken: parsed.data.authToken,
        mappings: parsed.data.mappings,
        cacheTtlMs: parsed.data.cacheTtlMs,
        requestTimeoutMs: parsed.data.requestTimeoutMs,
      }));
    }
  }

  await startMcpServer({ db: db.sqlite, knowledge });
}
