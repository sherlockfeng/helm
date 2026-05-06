import BetterSqlite3 from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor, formatBytes } from '../../../src/cli/doctor.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { PATHS } from '../../../src/constants.js';

let tmpDir: string;
let configFile: string;
let database: string;
let cursorHooks: string;
let bridgeSocket: string;
let logsDir: string;
let archiveDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-doctor-'));
  configFile = join(tmpDir, 'config.json');
  database = join(tmpDir, 'data.db');
  cursorHooks = join(tmpDir, 'hooks.json');
  bridgeSocket = join(tmpDir, 'bridge.sock');
  logsDir = join(tmpDir, 'logs');
  archiveDir = join(logsDir, 'archive');
});

afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const paths: typeof PATHS = {
  ...PATHS,
  // overridden per test via runDoctor's options.paths
};

function doctor(opts: Partial<{
  larkBin: string;
  larkExists: boolean;
}> = {}) {
  return runDoctor({
    paths: { ...paths, configFile, database, cursorHooks, bridgeSocket, logsDir, archiveDir },
    resolveLarkCli: () => opts.larkBin ?? '/no/such/lark-cli',
    now: () => new Date('2026-05-04T00:00:00Z'),
  });
}

describe('runDoctor — config check', () => {
  it('info when config absent', () => {
    const r = doctor();
    const c = r.checks.find((x) => x.label === 'Config')!;
    expect(c.level).toBe('info');
    expect(c.message).toMatch(/not present/);
  });

  it('ok when config valid', () => {
    writeFileSync(configFile, JSON.stringify({
      server: { port: 17317 }, lark: { enabled: true },
    }));
    const c = doctor().checks.find((x) => x.label === 'Config')!;
    expect(c.level).toBe('ok');
    expect(c.details?.['larkEnabled']).toBe(true);
  });

  it('attack: malformed config → error', () => {
    writeFileSync(configFile, '{not json');
    const c = doctor().checks.find((x) => x.label === 'Config')!;
    expect(c.level).toBe('error');
  });

  it('attack: schema-violating config → error', () => {
    writeFileSync(configFile, JSON.stringify({ server: { port: 'string-not-number' } }));
    const c = doctor().checks.find((x) => x.label === 'Config')!;
    expect(c.level).toBe('error');
  });
});

describe('runDoctor — database check', () => {
  it('info when db absent', () => {
    const c = doctor().checks.find((x) => x.label === 'Database')!;
    expect(c.level).toBe('info');
  });

  it('ok with schema version when db present', () => {
    const db = new BetterSqlite3(database);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.close();

    const c = doctor().checks.find((x) => x.label === 'Database')!;
    expect(c.level).toBe('ok');
    const versionDetails = c.details as { schemaVersion: number; migrations: number };
    expect(versionDetails.schemaVersion).toBeGreaterThan(0);
    expect(versionDetails.migrations).toBeGreaterThan(0);
  });

  it('attack: corrupt db file → error', () => {
    writeFileSync(database, 'this is not a sqlite file');
    const c = doctor().checks.find((x) => x.label === 'Database')!;
    expect(c.level).toBe('error');
  });
});

describe('runDoctor — Cursor hooks check', () => {
  it('warn when hooks.json absent', () => {
    const c = doctor().checks.find((x) => x.label === 'Cursor hooks')!;
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/helm install/);
  });

  it('warn when hooks.json present but no helm entries', () => {
    writeFileSync(cursorHooks, JSON.stringify({
      version: 1,
      hooks: { preToolUse: [{ command: 'something else' }] },
    }));
    const c = doctor().checks.find((x) => x.label === 'Cursor hooks')!;
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/no helm hooks/);
  });

  it('ok when helm-marked entries present in approval hooks', () => {
    writeFileSync(cursorHooks, JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [{ command: '/path/to/helm-hook --event preToolUse' }],
        beforeShellExecution: [{ command: '/path/to/helm-hook --event beforeShellExecution' }],
        sessionStart: [{ command: '/path/to/helm-hook --event sessionStart' }],
      },
    }));
    const c = doctor().checks.find((x) => x.label === 'Cursor hooks')!;
    expect(c.level).toBe('ok');
    expect(c.details?.['helmEntries']).toBe(3);
  });

  it('warn when helm registered but only on relay events (no approval)', () => {
    writeFileSync(cursorHooks, JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: 'helm-hook --event sessionStart' }] },
    }));
    const c = doctor().checks.find((x) => x.label === 'Cursor hooks')!;
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/re-run.*install/);
  });

  it('attack: malformed hooks.json → error', () => {
    writeFileSync(cursorHooks, '{not json');
    const c = doctor().checks.find((x) => x.label === 'Cursor hooks')!;
    expect(c.level).toBe('error');
  });
});

describe('runDoctor — bridge socket check', () => {
  it('info when not running', () => {
    const c = doctor().checks.find((x) => x.label === 'Bridge socket')!;
    expect(c.level).toBe('info');
  });

  it('ok when socket file exists', () => {
    writeFileSync(bridgeSocket, '');
    const c = doctor().checks.find((x) => x.label === 'Bridge socket')!;
    expect(c.level).toBe('ok');
    expect(c.message).toMatch(/appears to be running/);
  });
});

describe('runDoctor — lark-cli check', () => {
  it('info when binary not present at resolved path', () => {
    const c = doctor({ larkBin: '/no/such/path/lark-cli' }).checks.find((x) => x.label === 'Lark CLI')!;
    expect(c.level).toBe('info');
  });

  it('ok when binary present', () => {
    const realBin = join(tmpDir, 'lark-cli-stub');
    writeFileSync(realBin, '#!/bin/sh\nexit 0');
    const c = doctor({ larkBin: realBin }).checks.find((x) => x.label === 'Lark CLI')!;
    expect(c.level).toBe('ok');
  });

  it('attack: resolver throws → warn', () => {
    const r = runDoctor({
      paths: { ...paths, configFile, database, cursorHooks, bridgeSocket, logsDir, archiveDir },
      resolveLarkCli: () => { throw new Error('boom'); },
    });
    const c = r.checks.find((x) => x.label === 'Lark CLI')!;
    expect(c.level).toBe('warn');
  });
});

describe('runDoctor — logs check', () => {
  it('info when logs dir absent', () => {
    const c = doctor().checks.find((x) => x.label === 'Logs')!;
    expect(c.level).toBe('info');
  });

  it('reports main + archive sizes', () => {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'main.log'), 'a'.repeat(2048));
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'main.log.20260501T000000'), 'a'.repeat(1024));
    const c = doctor().checks.find((x) => x.label === 'Logs')!;
    expect(c.level).toBe('ok');
    expect(c.details?.['mainLogBytes']).toBe(2048);
    expect(c.details?.['archiveBytes']).toBe(1024);
    expect(c.details?.['archiveFiles']).toBe(1);
  });
});

describe('runDoctor — overall health', () => {
  it('healthy=true when all checks are ok/info', () => {
    // Empty tmp = config absent (info), db absent (info), bridge socket
    // absent (info), logs dir absent (info). Cursor hooks absent flips
    // to warn, so we seed it with a healthy helm install to land all
    // checks in ok/info territory.
    writeFileSync(cursorHooks, JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [{ command: '/path/to/helm-hook --event preToolUse' }],
        beforeShellExecution: [{ command: '/path/to/helm-hook --event beforeShellExecution' }],
      },
    }));
    expect(doctor().healthy).toBe(true);
  });

  it('healthy=false when any check warns', () => {
    writeFileSync(cursorHooks, JSON.stringify({ version: 1, hooks: {} }));
    expect(doctor().healthy).toBe(false);
  });

  it('healthy=false when any check errors', () => {
    writeFileSync(database, 'not a sqlite db');
    expect(doctor().healthy).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats with appropriate suffix', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(1023)).toBe('1023B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00GB');
  });
});
