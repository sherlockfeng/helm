#!/usr/bin/env node
/**
 * Helm CLI 入口
 * 详见 PROJECT_BLUEPRINT.md §18。
 *
 * Phase 0：仅 print 帮助；后续 Phase 在 src/cli/index.ts 实装子命令。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distEntry = join(__dirname, '..', 'dist', 'cli', 'index.js');

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  // dev / unbuilt fallback
  console.error('helm: backend not built. Run `pnpm build:backend` first.');
  console.error('Available subcommands (planned):');
  console.error('  helm                  Launch the Electron app');
  console.error('  helm hook             (internal) Cursor hook entry');
  console.error('  helm mcp              Run MCP stdio server (no GUI)');
  console.error('  helm install-hooks    Install Cursor hooks only');
  console.error('  helm uninstall-hooks');
  console.error('  helm doctor           Diagnostic info');
  process.exit(1);
}
