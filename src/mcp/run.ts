/**
 * MCP stdio entry point.
 *
 * Cursor (and other MCP clients) spawn this when they need an MCP connection.
 * Wires DB + knowledge registry, then connects over stdio.
 *
 * Phase 6 boots a fresh DB only — Phase 7.5 will populate the
 * KnowledgeProviderRegistry from `~/.helm/config.json` before connect.
 */

import { HelmDB } from '../storage/database.js';
import { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { startMcpServer } from './server.js';

export async function main(): Promise<void> {
  const db = new HelmDB();
  const knowledge = new KnowledgeProviderRegistry();
  // TODO Phase 7.5: load providers from config.json
  await startMcpServer({ db: db.sqlite, knowledge });
}
