import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maybeRotate, pruneArchive } from '../../../src/logger/rotate.js';

let dir: string;
let logPath: string;
let archiveDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-rotate-'));
  logPath = join(dir, 'main.log');
  archiveDir = join(dir, 'archive');
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('maybeRotate', () => {
  it('returns false when file is missing', () => {
    expect(maybeRotate(logPath)).toBe(false);
  });

  it('returns false when file size <= threshold', () => {
    writeFileSync(logPath, 'small');
    expect(maybeRotate(logPath, { fileMaxBytes: 1024 })).toBe(false);
    expect(existsSync(logPath)).toBe(true);
  });

  it('rotates when file exceeds threshold + creates archive entry', () => {
    writeFileSync(logPath, 'a'.repeat(2048));
    expect(maybeRotate(logPath, { fileMaxBytes: 1024 })).toBe(true);
    // Original file gone, archive has one entry
    expect(existsSync(logPath)).toBe(false);
    const archived = readdirSync(archiveDir);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.startsWith('main.log.')).toBe(true);
  });

  it('respects custom archiveDir', () => {
    const customArchive = join(dir, 'old');
    writeFileSync(logPath, 'a'.repeat(2048));
    maybeRotate(logPath, { fileMaxBytes: 1024, archiveDir: customArchive });
    expect(readdirSync(customArchive)).toHaveLength(1);
  });

  it('attack: rename failure surfaces via onError, no throw', () => {
    writeFileSync(logPath, 'a'.repeat(2048));
    const errs: Array<{ phase: string }> = [];
    // Pass an archiveDir that's the same as the source file path — rename
    // into-a-file fails on macOS / Linux.
    const result = maybeRotate(logPath, {
      fileMaxBytes: 1024,
      archiveDir: logPath, // intentional collision
      onError: (_err, ctx) => errs.push(ctx),
    });
    expect(result).toBe(false);
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  it('prunes oldest archive entries when archive total exceeds cap', () => {
    // Pre-seed archive with 3 files
    require('node:fs').mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'old1'), 'x'.repeat(100));
    writeFileSync(join(archiveDir, 'old2'), 'x'.repeat(100));
    writeFileSync(join(archiveDir, 'old3'), 'x'.repeat(100));
    // Make old1 oldest, old3 newest
    const fs = require('node:fs');
    fs.utimesSync(join(archiveDir, 'old1'), 1000, 1000);
    fs.utimesSync(join(archiveDir, 'old2'), 2000, 2000);
    fs.utimesSync(join(archiveDir, 'old3'), 3000, 3000);

    // Now rotate a new file; archive cap = 250 → must drop old1 (and maybe old2)
    writeFileSync(logPath, 'a'.repeat(2048));
    maybeRotate(logPath, { fileMaxBytes: 1024, archiveMaxBytes: 250, archiveDir });

    const remaining = readdirSync(archiveDir);
    expect(remaining).not.toContain('old1');
    expect(remaining.length).toBeLessThan(4);
  });
});

describe('pruneArchive', () => {
  it('returns no-op when archive missing', () => {
    expect(pruneArchive(join(dir, 'no-such-dir'), 100)).toEqual({ pruned: [], bytesAfter: 0 });
  });

  it('deletes oldest until under cap', () => {
    require('node:fs').mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'a'), 'x'.repeat(100));
    writeFileSync(join(archiveDir, 'b'), 'x'.repeat(100));
    writeFileSync(join(archiveDir, 'c'), 'x'.repeat(100));
    const fs = require('node:fs');
    fs.utimesSync(join(archiveDir, 'a'), 1000, 1000);
    fs.utimesSync(join(archiveDir, 'b'), 2000, 2000);
    fs.utimesSync(join(archiveDir, 'c'), 3000, 3000);

    const r = pruneArchive(archiveDir, 150);
    expect(r.pruned).toHaveLength(2);
    expect(r.bytesAfter).toBe(100); // 'c' alone
    expect(readdirSync(archiveDir)).toEqual(['c']);
  });

  it('attack: empty directory + cap=0 → no pruning, returns 0 bytes', () => {
    require('node:fs').mkdirSync(archiveDir, { recursive: true });
    const r = pruneArchive(archiveDir, 0);
    expect(r.pruned).toEqual([]);
    expect(r.bytesAfter).toBe(0);
  });

  it('keeps everything when total already <= cap', () => {
    require('node:fs').mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, 'a'), 'x'.repeat(50));
    expect(pruneArchive(archiveDir, 1000).pruned).toEqual([]);
    expect(statSync(join(archiveDir, 'a')).size).toBe(50);
  });
});
