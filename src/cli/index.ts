/**
 * Helm CLI entry — dispatched from `bin/helm.mjs`.
 *
 * Subcommands:
 *   helm doctor [--json]      Diagnostic dump
 *   helm install-hooks        Register helm in ~/.cursor/hooks.json
 *   helm uninstall-hooks      Remove helm entries from hooks.json
 *
 * Launching the Electron GUI is `pnpm dev` / packaged-DMG-double-click;
 * intentionally NOT a `helm` subcommand because that would conflate the
 * CLI's headless surface with the GUI process model.
 */

import { Command } from 'commander';
import { runDoctor } from './doctor.js';
import { formatDoctorJson, formatDoctorText } from './format.js';
import { installCursorHooks, uninstallCursorHooks } from '../host/cursor/installer.js';

export interface CliOptions {
  argv?: string[];
  out?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
}

export async function runCli(options: CliOptions = {}): Promise<void> {
  const out = options.out ?? ((line: string) => { process.stdout.write(line + '\n'); });
  const err = options.err ?? ((line: string) => { process.stderr.write(line + '\n'); });
  const exit = options.exit ?? ((code: number) => { process.exit(code); });

  const program = new Command();
  program
    .name('helm')
    .description('Helm — Cursor IDE chat manager')
    .exitOverride();

  program
    .command('doctor')
    .description('Print diagnostic info (paths / hooks / bridge / lark-cli / logs)')
    .option('--json', 'emit machine-readable JSON instead of formatted text')
    .action((opts: { json?: boolean }) => {
      const report = runDoctor();
      out(opts.json ? formatDoctorJson(report) : formatDoctorText(report));
      exit(report.healthy ? 0 : 1);
    });

  program
    .command('install-hooks')
    .description('Register helm in ~/.cursor/hooks.json (idempotent)')
    .action(() => {
      try {
        const result = installCursorHooks();
        out(`Installed ${result.events.length} hook event(s) into ${result.hooksPath}`);
        exit(0);
      } catch (e) {
        err(`install-hooks failed: ${(e as Error).message}`);
        exit(1);
      }
    });

  program
    .command('uninstall-hooks')
    .description('Remove helm entries from ~/.cursor/hooks.json')
    .action(() => {
      try {
        const result = uninstallCursorHooks();
        out(`Cleared helm entries from ${result.hooksPath}`);
        exit(0);
      } catch (e) {
        err(`uninstall-hooks failed: ${(e as Error).message}`);
        exit(1);
      }
    });

  try {
    await program.parseAsync(options.argv ?? process.argv);
  } catch (e) {
    // commander.exitOverride throws on missing subcommand / --help; map to
    // a clean exit so we don't dump a stack trace.
    const code = (e as { exitCode?: number }).exitCode ?? 1;
    exit(code);
  }
}

// CommonJS-friendly auto-run when this is the entry point. Using
// `require.main === module` would only work for CJS; check for explicit
// invocation flag instead. The bin script imports this module so it can
// always call runCli() itself; nothing else does.
