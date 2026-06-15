/**
 * MCP stdio entry point.
 *
 * Cursor (and other MCP clients) spawn this when they need an MCP connection.
 * Wires DB + knowledge registry, then connects over stdio.
 *
 * KnowledgeProviderRegistry is pre-populated with LocalRolesProvider
 * (backed by the seeded built-in roles + user-trained custom roles), plus
 * any provider declared in `~/.helm/config.json` (mcp-stdio bridges,
 * future wiki / SDK doc providers added without touching this file).
 */

import { HelmDB } from '../storage/database.js';
import { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { LocalRolesProvider } from '../knowledge/local-roles-provider.js';
import { RequirementsArchiveProvider } from '../knowledge/requirements-archive-provider.js';
import { startMcpServer } from './server.js';
import { makePseudoEmbedFn } from './embed.js';
import { loadHelmConfig } from '../config/loader.js';
import { createCursorAgentSpawner, type CursorAgentSpawner } from '../spawner/cursor-spawner.js';

export async function main(): Promise<void> {
  const db = new HelmDB();
  const knowledge = new KnowledgeProviderRegistry();

  knowledge.register(new LocalRolesProvider({
    db: db.sqlite,
    embedFn: makePseudoEmbedFn(),
  }));
  knowledge.register(new RequirementsArchiveProvider());

  const { config } = loadHelmConfig();

  // Phase 26: build the spawner from `cursor` config so the MCP tool
  // start_relay_chat_session can launch a fresh Cursor agent against a
  // project. Cloud mode without a key throws — degrade gracefully so the
  // rest of the MCP server still works.
  let spawner: CursorAgentSpawner | undefined;
  try {
    spawner = createCursorAgentSpawner({
      mode: config.cursor.mode,
      apiKey: config.cursor.apiKey,
      modelId: config.cursor.model,
    });
  } catch {
    // start_relay_chat_session will return an actionable errorResult.
    spawner = undefined;
  }

  await startMcpServer({ db: db.sqlite, knowledge, spawner });
}

// Phase 44: tsup bundles this module as `dist/mcp/stdio.js`, which Cursor
// invokes as a stdio MCP transport (`node dist/mcp/stdio.js`). Previously
// only `export { main }` survived the bundle — no top-level invocation —
// so the script did nothing and exited immediately, leaving Cursor with
// a dead MCP server. Run main() unconditionally on module load. Errors are
// surfaced to stderr (visible in Cursor's MCP debug panel) with a non-zero
// exit so the host marks the server as failed instead of silently ignoring.
main().catch((err) => {
  process.stderr.write(`[helm mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
