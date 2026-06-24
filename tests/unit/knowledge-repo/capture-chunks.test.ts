import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import {
  captureUnbackedRoleChunks,
  type CapturedPointWriter,
} from '../../../src/knowledge-repo/capture-chunks.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('captureUnbackedRoleChunks', () => {
  let db: BetterSqlite3.Database;
  let repoDir: string;

  beforeEach(() => {
    db = openDb();
    repoDir = mkdtempSync(join(tmpdir(), 'helm-cap-'));
    upsertRole(db, {
      id: 'ttp-proxy-expert', name: 'TTP Proxy 专家', systemPrompt: '',
      isBuiltin: false, createdAt: new Date().toISOString(),
    });
  });
  afterEach(() => {
    db.close();
    rmSync(repoDir, { recursive: true, force: true });
  });

  function chunk(id: string, sourceFile: string | null): void {
    db.prepare(`
      INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, source_file, created_at)
      VALUES (?, 'ttp-proxy-expert', 'body', 'other', ?, ?)
    `).run(id, sourceFile, new Date().toISOString());
  }
  function fileAt(rel: string): void {
    mkdirSync(join(repoDir, rel, '..'), { recursive: true });
    writeFileSync(join(repoDir, rel), 'x', 'utf8');
  }

  it('materializes only DB-only chunks; skips chat-captured and imported (file-backed) ones', async () => {
    // DB-only (bare doc name, no file on disk) — the MCP train_role case → write.
    chunk('c-db', 'ttp-proxy-架构与skill总览.md');
    chunk('c-db2', null); // no source_file at all → write
    // Already chat-captured (file present) → skip.
    chunk('c-cap', 'chat-captured/heyunfeng.feng/ttp-proxy-expert/c-cap.md');
    fileAt('chat-captured/heyunfeng.feng/ttp-proxy-expert/c-cap.md');
    // Imported team-tier doc (file present) → skip; never re-capture team knowledge.
    chunk('c-imp', 'domains/stability/og.md');
    fileAt('domains/stability/og.md');

    const calls: string[] = [];
    const manager: CapturedPointWriter = {
      writeCapturedPoint: async ({ chunkId }) => { calls.push(chunkId); return { relPath: `chat-captured/x/${chunkId}.md` }; },
    };
    const n = await captureUnbackedRoleChunks({
      db, manager, repoId: 'r1', repoLocalPath: repoDir,
      username: 'heyunfeng.feng', roleId: 'ttp-proxy-expert',
    });
    expect(n).toBe(2);
    expect(calls.sort()).toEqual(['c-db', 'c-db2']);
  });

  it('reports failures via onError and keeps going', async () => {
    chunk('ok', 'a.md');
    chunk('boom', 'b.md');
    const errors: string[] = [];
    const manager: CapturedPointWriter = {
      writeCapturedPoint: async ({ chunkId }) => {
        if (chunkId === 'boom') throw new Error('disk full');
        return { relPath: `chat-captured/x/${chunkId}.md` };
      },
    };
    const n = await captureUnbackedRoleChunks({
      db, manager, repoId: 'r1', repoLocalPath: repoDir,
      username: 'u', roleId: 'ttp-proxy-expert',
      onError: (chunkId, message) => errors.push(`${chunkId}:${message}`),
    });
    expect(n).toBe(1); // 'ok' written, 'boom' failed but didn't abort
    expect(errors).toEqual(['boom:disk full']);
  });
});
