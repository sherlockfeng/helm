import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../src/storage/migrations.js';
import { upsertHostSession, getHostSession, setHostSessionDisplayName } from '../../../../src/storage/repos/host-sessions.js';
import {
  findTranscriptPath,
  refreshClaudeSessionTitle,
} from '../../../../src/host/claude-code/title-refresh.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const SID = 'aaaa1111-2222-3333-4444-555566667777';

function seedSession(db: BetterSqlite3.Database, host = 'claude-code'): void {
  const now = new Date().toISOString();
  upsertHostSession(db, { id: SID, host, status: 'active', firstSeenAt: now, lastSeenAt: now });
}

function writeTranscript(root: string, projectDir: string, title?: string): string {
  const dir = join(root, projectDir);
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ role: 'user', content: 'hi' })];
  if (title) lines.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: SID }));
  const p = join(dir, `${SID}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('findTranscriptPath', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'helm-title-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('locates the transcript across project dirs', () => {
    writeTranscript(root, '-Users-x-proj-a');
    expect(findTranscriptPath(SID, root)).toBe(join(root, '-Users-x-proj-a', `${SID}.jsonl`));
  });

  it('returns null when nothing matches / root missing', () => {
    expect(findTranscriptPath('nope', root)).toBeNull();
    expect(findTranscriptPath(SID, join(root, 'ghost'))).toBeNull();
  });
});

describe('refreshClaudeSessionTitle', () => {
  let db: BetterSqlite3.Database;
  let root: string;
  beforeEach(() => {
    db = openDb();
    root = mkdtempSync(join(tmpdir(), 'helm-title-'));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('updates display_name from a fresh transcript title', () => {
    seedSession(db);
    writeTranscript(root, '-p', 'renamed-in-tui');
    expect(refreshClaudeSessionTitle(db, SID, root)).toBe(true);
    expect(getHostSession(db, SID)?.displayName).toBe('renamed-in-tui');
  });

  it('no-ops when the title is unchanged', () => {
    seedSession(db);
    setHostSessionDisplayName(db, SID, 'same');
    writeTranscript(root, '-p', 'same');
    expect(refreshClaudeSessionTitle(db, SID, root)).toBe(false);
  });

  it('no-ops for non-claude sessions even with a matching transcript', () => {
    seedSession(db, 'cursor');
    writeTranscript(root, '-p', 'should-not-apply');
    expect(refreshClaudeSessionTitle(db, SID, root)).toBe(false);
    expect(getHostSession(db, SID)?.displayName).toBeUndefined();
  });

  it('no-ops when the transcript has no custom-title rows', () => {
    seedSession(db);
    writeTranscript(root, '-p');
    expect(refreshClaudeSessionTitle(db, SID, root)).toBe(false);
  });

  it('no-ops for an unknown session id', () => {
    expect(refreshClaudeSessionTitle(db, 'ghost', root)).toBe(false);
  });
});
