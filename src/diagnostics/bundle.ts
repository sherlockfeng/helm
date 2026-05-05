/**
 * Diagnostics bundle generator — see PROJECT_BLUEPRINT.md §19.5.3.
 *
 * Produces a directory `<targetDir>/helm-diagnostics-<timestamp>/` with:
 *
 *   manifest.json          — version, generated time, included files
 *   config.json            — `~/.helm/config.json` with sensitive fields redacted
 *   schema-version.json    — applied SQLite migration versions
 *   doctor.json            — paths + binary versions + bridge socket presence
 *   logs/main.log          — copied from `<rootDir>/main.log`     (truncated)
 *   logs/error.log         — copied from `<rootDir>/error.log`    (truncated)
 *   logs/sessions/<id>.jsonl — most-recent N session log files     (truncated)
 *
 * Each log copy is truncated to the most recent N bytes (default 1MB) so a
 * runaway log doesn't bloat the bundle. Sensitive fields in config.json
 * (apiKey/authToken/etc.) are stripped via the existing redact() helper.
 *
 * The bundle is a directory, not a zip — keeps zero deps. The Diagnostics UI
 * button can shell out to `tar -czf` if the user wants a single artifact.
 *
 * Failures degrade gracefully: missing config / log files become empty entries
 * in the manifest. The bundle path is always returned so the user has
 * something to share even when individual sources are missing.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { redact } from '../logger/redact.js';
import { PATHS } from '../constants.js';

export interface DiagnosticsBundleOptions {
  /** Target directory; bundle is created as a child of this. Defaults to ~/.helm/. */
  targetDir?: string;
  /** Path to config.json. Defaults to PATHS.configFile. */
  configPath?: string;
  /** Path to log root. Defaults to PATHS.logsDir. */
  logsDir?: string;
  /** Bridge socket path to probe for the doctor section. Defaults to PATHS.bridgeSocket. */
  bridgeSocketPath?: string;
  /** Per-log-file copy cap. Default 1MB. */
  perFileMaxBytes?: number;
  /** Max number of recent session log files to include. Default 5. */
  maxSessionFiles?: number;
  /** Optional DB to read schema versions from. */
  db?: Database.Database;
  /** Test seam for deterministic timestamps. */
  now?: () => Date;
  /** App version metadata; surfaces in the manifest + bundle directory name. */
  appVersion?: string;
}

export interface BundleResult {
  bundleDir: string;
  manifest: BundleManifest;
}

export interface BundleManifest {
  generatedAt: string;
  appVersion: string;
  files: Array<{ path: string; bytes: number; truncated?: boolean; reason?: string }>;
  warnings: string[];
}

const DEFAULT_PER_FILE_MAX = 1 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 5;

function timestampSuffix(now: Date): string {
  return now.toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function copyTruncated(srcPath: string, destPath: string, maxBytes: number): { bytes: number; truncated: boolean } {
  const stat = statSync(srcPath);
  if (stat.size <= maxBytes) {
    copyFileSync(srcPath, destPath);
    return { bytes: stat.size, truncated: false };
  }
  // Read the trailing maxBytes (the most recent log lines are what we usually want).
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(srcPath, 'r');
  try {
    readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
  } finally {
    closeSync(fd);
  }
  writeFileSync(destPath, buf);
  return { bytes: maxBytes, truncated: true };
}

export function createDiagnosticsBundle(options: DiagnosticsBundleOptions = {}): BundleResult {
  const targetDir = options.targetDir ?? PATHS.logsDir.replace(/\/logs$/, '');
  const configPath = options.configPath ?? PATHS.configFile;
  const logsDir = options.logsDir ?? PATHS.logsDir;
  const bridgeSocketPath = options.bridgeSocketPath ?? PATHS.bridgeSocket;
  const perFileMaxBytes = options.perFileMaxBytes ?? DEFAULT_PER_FILE_MAX;
  const maxSessionFiles = options.maxSessionFiles ?? DEFAULT_MAX_SESSIONS;
  const now = options.now ?? (() => new Date());
  const appVersion = options.appVersion ?? '0.1.0';

  const bundleName = `helm-diagnostics-${timestampSuffix(now())}`;
  const bundleDir = join(targetDir, bundleName);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(bundleDir, 'logs'), { recursive: true });
  mkdirSync(join(bundleDir, 'logs', 'sessions'), { recursive: true });

  const manifest: BundleManifest = {
    generatedAt: now().toISOString(),
    appVersion,
    files: [],
    warnings: [],
  };

  // 1. Redacted config.
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
      const safe = redact(raw);
      const dest = join(bundleDir, 'config.json');
      writeFileSync(dest, JSON.stringify(safe, null, 2));
      manifest.files.push({ path: 'config.json', bytes: statSync(dest).size });
    } catch (err) {
      manifest.warnings.push(`config.json read/parse failed: ${(err as Error).message}`);
    }
  } else {
    manifest.warnings.push('config.json not present (default config in use)');
  }

  // 2. Schema version dump.
  let schemaVersions: Array<{ version: number; description: string; appliedAt: string }> = [];
  if (options.db) {
    try {
      schemaVersions = (options.db.prepare(
        `SELECT version, description, applied_at FROM schema_migrations ORDER BY version ASC`,
      ).all() as Array<{ version: number; description: string; applied_at: string }>)
        .map((r) => ({ version: r.version, description: r.description, appliedAt: r.applied_at }));
    } catch (err) {
      manifest.warnings.push(`schema_migrations read failed: ${(err as Error).message}`);
    }
  }
  const schemaPath = join(bundleDir, 'schema-version.json');
  writeFileSync(schemaPath, JSON.stringify(schemaVersions, null, 2));
  manifest.files.push({ path: 'schema-version.json', bytes: statSync(schemaPath).size });

  // 3. Doctor — paths, runtime versions, bridge socket presence.
  const doctor = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    paths: {
      configFile: configPath,
      logsDir,
      bridgeSocket: bridgeSocketPath,
    },
    bridgeSocketExists: existsSync(bridgeSocketPath),
  };
  const doctorPath = join(bundleDir, 'doctor.json');
  writeFileSync(doctorPath, JSON.stringify(doctor, null, 2));
  manifest.files.push({ path: 'doctor.json', bytes: statSync(doctorPath).size });

  // 4. Main + error logs.
  for (const name of ['main.log', 'error.log']) {
    const src = join(logsDir, name);
    if (!existsSync(src)) {
      manifest.warnings.push(`${name} not present`);
      continue;
    }
    try {
      const dest = join(bundleDir, 'logs', name);
      const r = copyTruncated(src, dest, perFileMaxBytes);
      manifest.files.push({ path: `logs/${name}`, bytes: r.bytes, truncated: r.truncated });
    } catch (err) {
      manifest.warnings.push(`${name} copy failed: ${(err as Error).message}`);
    }
  }

  // 5. Recent session logs (most recently modified, capped).
  const sessionsDir = join(logsDir, 'sessions');
  if (existsSync(sessionsDir)) {
    try {
      const entries = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => {
          const p = join(sessionsDir, e.name);
          return { path: p, mtimeMs: statSync(p).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, maxSessionFiles);

      for (const entry of entries) {
        const dest = join(bundleDir, 'logs', 'sessions', basename(entry.path));
        const r = copyTruncated(entry.path, dest, perFileMaxBytes);
        manifest.files.push({
          path: `logs/sessions/${basename(entry.path)}`,
          bytes: r.bytes, truncated: r.truncated,
        });
      }
    } catch (err) {
      manifest.warnings.push(`sessions enumeration failed: ${(err as Error).message}`);
    }
  }

  // 6. Manifest.
  const manifestPath = join(bundleDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { bundleDir, manifest };
}
