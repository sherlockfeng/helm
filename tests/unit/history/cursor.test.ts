import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanCursorHistory } from '../../../src/history/cursor.js';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-cursor-'));
  dbPath = join(dir, 'state.vscdb');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(rows: [string, string][]): void {
  const db = new BetterSqlite3(dbPath);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  for (const [k, v] of rows) ins.run(k, v);
  db.close();
}

describe('cursor history parser', () => {
  it('imports a real composer and survives a null composerData row', () => {
    const good = {
      composerId: 'good',
      name: 'My chat',
      createdAt: 1_700_000_000_000,
      lastUpdatedAt: 1_700_000_100_000,
      fullConversationHeadersOnly: [
        { bubbleId: 'b1', type: 1 },
        { bubbleId: 'b2', type: 2 },
      ],
    };
    seed([
      // The bug: a literal `null` row threw past the JSON catch and emptied
      // the whole scan. It must be skipped, not fatal.
      ['composerData:broken', 'null'],
      ['composerData:nonobj', '"a string"'],
      ['composerData:good', JSON.stringify(good)],
      ['bubbleId:good:b1', JSON.stringify({ type: 1, text: 'the question' })],
      ['bubbleId:good:b2', JSON.stringify({ type: 2, text: 'the answer' })],
      ['bubbleId:good:bad', 'null'],
    ]);
    const out = scanCursorHistory(dbPath);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('good');
    expect(out[0]!.host).toBe('cursor');
    expect(out[0]!.turns).toEqual([
      { kind: 'prompt', text: 'the question', createdAt: new Date(1_700_000_000_000).toISOString() },
      { kind: 'response', text: 'the answer', createdAt: new Date(1_700_000_000_000).toISOString() },
    ]);
    expect(out[0]!.firstPrompt).toBe('My chat');
  });

  it('drops a composer with no real exchange (only a prompt)', () => {
    seed([
      ['composerData:x', JSON.stringify({ composerId: 'x', fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }] })],
      ['bubbleId:x:b1', JSON.stringify({ type: 1, text: 'hi' })],
    ]);
    expect(scanCursorHistory(dbPath)).toHaveLength(0);
  });

  it('returns [] when the db file does not exist', () => {
    expect(scanCursorHistory(join(dir, 'nope.vscdb'))).toEqual([]);
  });
});
