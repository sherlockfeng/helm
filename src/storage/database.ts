import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from '../constants.js';
import { runMigrations } from './migrations.js';

export * from './types.js';
export * from './repos/campaigns.js';
export * from './repos/roles.js';
export * from './repos/requirements.js';
export * from './repos/doc-audit.js';
export * from './repos/host-sessions.js';
export * from './repos/channel-bindings.js';
export * from './repos/approval.js';
export * from './repos/host-event-log.js';

export class HelmDB {
  readonly sqlite: BetterSqlite3.Database;

  constructor(dbPath: string = PATHS.database) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new BetterSqlite3(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    runMigrations(this.sqlite);
  }

  close(): void {
    this.sqlite.close();
    if (singleton === this) singleton = undefined;
  }
}

let singleton: HelmDB | undefined;

export function getDatabase(dbPath?: string): HelmDB {
  if (!singleton) {
    singleton = new HelmDB(dbPath ?? PATHS.database);
  }
  return singleton;
}

export function closeDatabase(): void {
  singleton?.close();
  singleton = undefined;
}
