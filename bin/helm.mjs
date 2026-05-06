#!/usr/bin/env node
/**
 * Helm CLI entry. Hands off to the compiled `dist/cli/index.js`.
 *
 * Subcommands (see src/cli/index.ts):
 *   helm doctor            Diagnostic info (paths / hooks / bridge / lark-cli)
 *   helm install-hooks     Register helm in ~/.cursor/hooks.json
 *   helm uninstall-hooks   Remove helm entries from ~/.cursor/hooks.json
 *
 * Detailed CLI surface in PROJECT_BLUEPRINT.md §18.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distEntry = join(__dirname, '..', 'dist', 'cli', 'index.js');

if (existsSync(distEntry)) {
  const mod = await import(distEntry);
  if (typeof mod.runCli === 'function') {
    await mod.runCli();
  } else {
    console.error('helm: compiled CLI module is missing runCli export.');
    process.exit(1);
  }
} else {
  console.error('helm: backend not built. Run `pnpm build:backend` first.');
  console.error('Available subcommands once built:');
  console.error('  helm doctor           Diagnostic info');
  console.error('  helm install-hooks    Register helm hooks in Cursor');
  console.error('  helm uninstall-hooks  Remove helm hooks');
  process.exit(1);
}
