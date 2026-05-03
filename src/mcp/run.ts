/**
 * MCP stdio entry point.
 *
 * Cursor (and other MCP clients) spawn this when they need an MCP connection.
 * Wires DB + knowledge registry, then connects over stdio.
 *
 * Phase 7.5: KnowledgeProviderRegistry is pre-populated with LocalRolesProvider
 * (backed by the seeded built-in roles + any user-trained custom roles). Future
 * providers (DepscopeProvider in Phase 13, wiki, etc.) load from
 * `~/.helm/config.json` here.
 */

import { HelmDB } from '../storage/database.js';
import { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { LocalRolesProvider } from '../knowledge/local-roles-provider.js';
import { startMcpServer } from './server.js';
import { makePseudoEmbedFn } from './embed.js';

export async function main(): Promise<void> {
  const db = new HelmDB();
  const knowledge = new KnowledgeProviderRegistry();

  knowledge.register(new LocalRolesProvider({
    db: db.sqlite,
    embedFn: makePseudoEmbedFn(),
  }));

  // TODO Phase 13: load DepscopeProvider from `~/.helm/config.json` here.

  await startMcpServer({ db: db.sqlite, knowledge });
}
