import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { updateDocFirst } from '../../../src/workflow/doc-first.js';
import { getDocAudit } from '../../../src/storage/repos/doc-audit.js';

let db: BetterSqlite3.Database;
let baseDir: string;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  baseDir = mkdtempSync(join(tmpdir(), 'helm-doc-first-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  db.close();
});

describe('updateDocFirst', () => {
  it('writes the file and returns an audit token', () => {
    const r = updateDocFirst(db, { filePath: 'docs/PRD.md', content: '# PRD\nhello', baseDir });
    expect(readFileSync(r.filePath, 'utf8')).toBe('# PRD\nhello');
    expect(r.auditToken).toBeTruthy();
    expect(getDocAudit(db, r.auditToken)?.filePath).toBe(r.filePath);
  });

  it('creates intermediate directories', () => {
    const r = updateDocFirst(db, { filePath: 'a/b/c/d.md', content: 'x', baseDir });
    expect(readFileSync(r.filePath, 'utf8')).toBe('x');
  });

  it('overwrites existing file', () => {
    const a = updateDocFirst(db, { filePath: 'doc.md', content: 'one', baseDir });
    const b = updateDocFirst(db, { filePath: 'doc.md', content: 'two', baseDir });
    expect(readFileSync(a.filePath, 'utf8')).toBe('two');
    expect(a.auditToken).not.toBe(b.auditToken);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('respects absolute paths (ignores baseDir)', () => {
    const abs = join(baseDir, 'absolute.md');
    const r = updateDocFirst(db, { filePath: abs, content: 'abs', baseDir: '/somewhere/else' });
    expect(r.filePath).toBe(abs);
  });

  it('attack: empty filePath throws', () => {
    expect(() => updateDocFirst(db, { filePath: '', content: 'x' })).toThrow(/filePath/);
    expect(() => updateDocFirst(db, { filePath: '   ', content: 'x' })).toThrow(/filePath/);
  });

  it('content hash is deterministic for same content', () => {
    const r1 = updateDocFirst(db, { filePath: 'a.md', content: 'same', baseDir });
    const r2 = updateDocFirst(db, { filePath: 'b.md', content: 'same', baseDir });
    expect(r1.contentHash).toBe(r2.contentHash);
  });

  it('records taskId on the audit row when provided', () => {
    const r = updateDocFirst(db, { filePath: 'a.md', content: 'x', taskId: 'task_123', baseDir });
    expect(getDocAudit(db, r.auditToken)?.taskId).toBe('task_123');
  });
});
