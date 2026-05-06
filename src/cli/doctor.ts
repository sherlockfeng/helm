/**
 * `helm doctor` — gather diagnostic data so users can verify install + send
 * useful info with bug reports. See PROJECT_BLUEPRINT.md §16 / §19.
 *
 * Pure data-gathering: returns a typed report. The CLI formatter
 * (src/cli/format.ts) renders text vs JSON. Tests pass tmp paths to
 * exercise every branch without touching the real `~/.helm/`.
 *
 * Probes:
 *   - Node + platform versions
 *   - ~/.helm/config.json (loaded? validation errors?)
 *   - ~/.helm/data.db (exists? schema version?)
 *   - ~/.cursor/hooks.json (loaded? helm marker present? events covered?)
 *   - ~/.helm/bridge.sock (running? socket file present?)
 *   - Lark CLI command (resolvable? from env / config / bundled?)
 *   - Logs (rotation working? archive size?)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { PATHS, HOOK_MARKER } from '../constants.js';
import { loadHelmConfig } from '../config/loader.js';
import { resolveLarkCliCommand } from '../channel/lark/cli-runner.js';

export type CheckLevel = 'ok' | 'warn' | 'error' | 'info';

export interface DoctorCheck {
  /** Human-readable check name. */
  label: string;
  level: CheckLevel;
  /** One-line status. */
  message: string;
  /** Optional structured data (paths, versions). */
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  generatedAt: string;
  node: { version: string; platform: string; arch: string };
  checks: DoctorCheck[];
  /** True iff every check is `ok` or `info`. */
  healthy: boolean;
}

export interface DoctorOptions {
  /** Override paths for tests. */
  paths?: Partial<typeof PATHS>;
  /** Inject lark-cli resolver for tests. */
  resolveLarkCli?: () => string;
  /** Test seam: clock for generatedAt. */
  now?: () => Date;
}

function effectivePaths(override?: Partial<typeof PATHS>): typeof PATHS {
  return { ...PATHS, ...(override ?? {}) };
}

function checkConfig(paths: typeof PATHS): DoctorCheck {
  if (!existsSync(paths.configFile)) {
    return {
      label: 'Config',
      level: 'info',
      message: `${paths.configFile} not present (defaults in use)`,
      details: { path: paths.configFile, loaded: false },
    };
  }
  const errors: string[] = [];
  const { config, loaded } = loadHelmConfig({
    path: paths.configFile,
    onError: (err) => errors.push(err.message),
  });
  if (!loaded) {
    return {
      label: 'Config',
      level: 'error',
      message: `${paths.configFile} present but failed to load: ${errors.join('; ')}`,
      details: { path: paths.configFile, loaded: false, errors },
    };
  }
  return {
    label: 'Config',
    level: 'ok',
    message: `${paths.configFile} loaded (lark.enabled=${config.lark.enabled}, ${config.knowledge.providers.length} provider(s))`,
    details: {
      path: paths.configFile,
      loaded: true,
      larkEnabled: config.lark.enabled,
      providerCount: config.knowledge.providers.length,
      port: config.server.port,
    },
  };
}

function checkDatabase(paths: typeof PATHS): DoctorCheck {
  if (!existsSync(paths.database)) {
    return {
      label: 'Database',
      level: 'info',
      message: `${paths.database} not present (will be created on first run)`,
      details: { path: paths.database, exists: false },
    };
  }
  let version = 0;
  let migrations = 0;
  try {
    const db = new BetterSqlite3(paths.database, { readonly: true });
    try {
      const rows = db.prepare(
        `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
      ).all() as Array<{ version: number }>;
      version = rows[0]?.version ?? 0;
      const all = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number };
      migrations = all.n;
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      label: 'Database',
      level: 'error',
      message: `cannot open ${paths.database}: ${(err as Error).message}`,
      details: { path: paths.database, exists: true },
    };
  }
  return {
    label: 'Database',
    level: 'ok',
    message: `${paths.database} (schema v${version}, ${migrations} migration${migrations === 1 ? '' : 's'} applied)`,
    details: { path: paths.database, exists: true, schemaVersion: version, migrations },
  };
}

const APPROVAL_HOOK_EVENTS = ['beforeShellExecution', 'beforeMCPExecution', 'preToolUse'];

function checkCursorHooks(paths: typeof PATHS): DoctorCheck {
  if (!existsSync(paths.cursorHooks)) {
    return {
      label: 'Cursor hooks',
      level: 'warn',
      message: `${paths.cursorHooks} not present — run \`helm install\` to register hooks`,
      details: { path: paths.cursorHooks, exists: false },
    };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(paths.cursorHooks, 'utf8')); }
  catch (err) {
    return {
      label: 'Cursor hooks',
      level: 'error',
      message: `${paths.cursorHooks} invalid JSON: ${(err as Error).message}`,
      details: { path: paths.cursorHooks, exists: true },
    };
  }
  const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? (parsed as { hooks?: Record<string, Array<{ command?: unknown }>> })
    : { hooks: {} };
  const hooks = obj.hooks ?? {};

  const eventsWithHelm: string[] = [];
  let totalHelmEntries = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const helmEntries = entries.filter((e) =>
      typeof e?.command === 'string' && (e.command).includes(HOOK_MARKER));
    if (helmEntries.length > 0) {
      eventsWithHelm.push(event);
      totalHelmEntries += helmEntries.length;
    }
  }

  if (totalHelmEntries === 0) {
    return {
      label: 'Cursor hooks',
      level: 'warn',
      message: `${paths.cursorHooks} present but no helm hooks installed — run \`helm install\``,
      details: { path: paths.cursorHooks, exists: true, helmEntries: 0 },
    };
  }
  const missingApproval = APPROVAL_HOOK_EVENTS.filter((e) => !eventsWithHelm.includes(e));
  if (missingApproval.length === APPROVAL_HOOK_EVENTS.length) {
    return {
      label: 'Cursor hooks',
      level: 'warn',
      message: `helm registered for ${eventsWithHelm.length} event(s) but no approval hooks — re-run \`helm install\``,
      details: { path: paths.cursorHooks, helmEntries: totalHelmEntries, events: eventsWithHelm, missingApproval },
    };
  }
  return {
    label: 'Cursor hooks',
    level: 'ok',
    message: `${paths.cursorHooks} (${totalHelmEntries} helm entries across ${eventsWithHelm.length} event(s))`,
    details: { path: paths.cursorHooks, helmEntries: totalHelmEntries, events: eventsWithHelm },
  };
}

function checkBridgeSocket(paths: typeof PATHS): DoctorCheck {
  const exists = existsSync(paths.bridgeSocket);
  return {
    label: 'Bridge socket',
    level: exists ? 'ok' : 'info',
    message: exists
      ? `${paths.bridgeSocket} (helm app appears to be running)`
      : `${paths.bridgeSocket} not present (helm app not running, or hasn't started)`,
    details: { path: paths.bridgeSocket, exists },
  };
}

function checkLarkCli(resolve: () => string): DoctorCheck {
  let resolved = '';
  try { resolved = resolve(); }
  catch (err) {
    return {
      label: 'Lark CLI',
      level: 'warn',
      message: `failed to resolve lark-cli command: ${(err as Error).message}`,
    };
  }
  const exists = existsSync(resolved);
  return {
    label: 'Lark CLI',
    level: exists ? 'ok' : 'info',
    message: exists
      ? `${resolved}`
      : `${resolved} (path resolved but binary not present — set LARK_CLI_COMMAND or install lark-cli to enable Lark integration)`,
    details: { resolved, exists },
  };
}

function dirSize(dir: string): { totalBytes: number; fileCount: number } {
  if (!existsSync(dir)) return { totalBytes: 0, fileCount: 0 };
  let totalBytes = 0;
  let fileCount = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const p = join(dir, entry.name);
      try {
        totalBytes += statSync(p).size;
        fileCount += 1;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return { totalBytes, fileCount };
}

function checkLogs(paths: typeof PATHS): DoctorCheck {
  if (!existsSync(paths.logsDir)) {
    return {
      label: 'Logs',
      level: 'info',
      message: `${paths.logsDir} not present (will be created on first log write)`,
      details: { path: paths.logsDir, exists: false },
    };
  }
  const main = existsSync(join(paths.logsDir, 'main.log'))
    ? statSync(join(paths.logsDir, 'main.log')).size
    : 0;
  const archive = dirSize(paths.archiveDir);
  return {
    label: 'Logs',
    level: 'ok',
    message: `main.log ${formatBytes(main)}, archive ${formatBytes(archive.totalBytes)} across ${archive.fileCount} file(s)`,
    details: {
      logsDir: paths.logsDir,
      mainLogBytes: main,
      archiveBytes: archive.totalBytes,
      archiveFiles: archive.fileCount,
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const paths = effectivePaths(options.paths);
  const now = options.now ?? (() => new Date());
  const resolveLark = options.resolveLarkCli ?? (() => resolveLarkCliCommand());

  const checks: DoctorCheck[] = [
    checkConfig(paths),
    checkDatabase(paths),
    checkCursorHooks(paths),
    checkBridgeSocket(paths),
    checkLarkCli(resolveLark),
    checkLogs(paths),
  ];

  const healthy = checks.every((c) => c.level === 'ok' || c.level === 'info');
  return {
    generatedAt: now().toISOString(),
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    checks,
    healthy,
  };
}
