import BetterSqlite3 from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { createDiagnosticsBundle } from '../../../src/diagnostics/bundle.js';

let tmpDir: string;
let configPath: string;
let logsDir: string;
let bridgeSocketPath: string;
let db: BetterSqlite3.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-diag-'));
  configPath = join(tmpDir, 'config.json');
  logsDir = join(tmpDir, 'logs');
  bridgeSocketPath = join(tmpDir, 'bridge.sock');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(join(logsDir, 'sessions'), { recursive: true });
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createDiagnosticsBundle', () => {
  it('creates a timestamped directory under targetDir', () => {
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    expect(existsSync(r.bundleDir)).toBe(true);
    expect(r.bundleDir.startsWith(join(tmpDir, 'helm-diagnostics-'))).toBe(true);
    expect(existsSync(join(r.bundleDir, 'manifest.json'))).toBe(true);
  });

  it('redacts sensitive fields in config.json', () => {
    writeFileSync(configPath, JSON.stringify({
      lark: { authToken: 'sk-supersecret-12345' },
      knowledge: { providers: [{ id: 'depscope', config: { authToken: 'longTokenABCDEF' } }] },
    }));
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    const out = JSON.parse(readFileSync(join(r.bundleDir, 'config.json'), 'utf8')) as {
      lark: { authToken: string };
      knowledge: { providers: Array<{ config: { authToken: string } }> };
    };
    expect(out.lark.authToken).not.toContain('supersecret');
    expect(out.knowledge.providers[0]!.config.authToken).not.toContain('ABCDEF');
  });

  it('manifest captures generated timestamp + warnings + file list', () => {
    writeFileSync(configPath, JSON.stringify({ server: { port: 17317 } }));
    writeFileSync(join(logsDir, 'main.log'), '{"ts":"2026-05-04T00:00:00Z","level":"info"}\n');
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    expect(r.manifest.appVersion).toBe('0.1.0');
    expect(new Date(r.manifest.generatedAt).getTime()).toBeGreaterThan(0);
    const paths = r.manifest.files.map((f) => f.path);
    expect(paths).toContain('config.json');
    expect(paths).toContain('logs/main.log');
    expect(paths).toContain('schema-version.json');
    expect(paths).toContain('doctor.json');
  });

  it('truncates large log files to perFileMaxBytes', () => {
    const big = 'L'.repeat(20_000) + '\n';
    writeFileSync(join(logsDir, 'main.log'), big.repeat(20)); // ~400KB
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
      perFileMaxBytes: 1024,
    });
    const mainLogEntry = r.manifest.files.find((f) => f.path === 'logs/main.log');
    expect(mainLogEntry?.bytes).toBe(1024);
    expect(mainLogEntry?.truncated).toBe(true);
  });

  it('includes most-recent N session files only', () => {
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(logsDir, 'sessions', `sess_${i}.jsonl`), `${i}\n`);
    }
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
      maxSessionFiles: 3,
    });
    const sessions = r.manifest.files.filter((f) => f.path.startsWith('logs/sessions/'));
    expect(sessions).toHaveLength(3);
  });

  it('schema-version.json reflects applied migrations', () => {
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    const versions = JSON.parse(readFileSync(join(r.bundleDir, 'schema-version.json'), 'utf8')) as Array<{ version: number }>;
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]?.version).toBe(1);
  });

  it('doctor.json captures runtime + bridge socket presence', () => {
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    const doctor = JSON.parse(readFileSync(join(r.bundleDir, 'doctor.json'), 'utf8')) as {
      nodeVersion: string;
      bridgeSocketExists: boolean;
    };
    expect(doctor.nodeVersion).toBe(process.version);
    expect(doctor.bridgeSocketExists).toBe(false);
  });

  it('attack: missing config.json → warning, bundle still created', () => {
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    expect(r.manifest.warnings.some((w) => w.includes('config.json'))).toBe(true);
    expect(existsSync(r.bundleDir)).toBe(true);
  });

  it('attack: malformed config.json → warning, bundle still created', () => {
    writeFileSync(configPath, '{not json');
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    expect(r.manifest.warnings.some((w) => w.includes('config.json'))).toBe(true);
    expect(r.manifest.files.some((f) => f.path === 'config.json')).toBe(false);
  });

  it('attack: missing logs dir → warnings but doctor + manifest still emitted', () => {
    rmSync(logsDir, { recursive: true });
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath, db,
    });
    expect(r.manifest.warnings.some((w) => w.includes('main.log'))).toBe(true);
    expect(existsSync(join(r.bundleDir, 'manifest.json'))).toBe(true);
  });

  it('attack: bundle generation when no DB provided still produces empty schema-version.json', () => {
    const r = createDiagnosticsBundle({
      targetDir: tmpDir, configPath, logsDir, bridgeSocketPath,
    });
    const versions = JSON.parse(readFileSync(join(r.bundleDir, 'schema-version.json'), 'utf8'));
    expect(versions).toEqual([]);
  });
});
