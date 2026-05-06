import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RequirementsArchiveProvider,
  findArchiveDir,
} from '../../../src/knowledge/requirements-archive-provider.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-archives-'));
});

afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function writeArchive(dir: string, name: string, content: string, mtimeSec?: number): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  if (mtimeSec !== undefined) {
    utimesSync(path, mtimeSec, mtimeSec);
  }
}

describe('findArchiveDir', () => {
  it('returns the directory when it exists at cwd', () => {
    mkdirSync(join(tmpDir, 'requirements'));
    expect(findArchiveDir(tmpDir)).toBe(join(tmpDir, 'requirements'));
  });

  it('walks up to find a parent directory containing requirements/', () => {
    mkdirSync(join(tmpDir, 'requirements'));
    const sub = join(tmpDir, 'pkg', 'a');
    mkdirSync(sub, { recursive: true });
    expect(findArchiveDir(sub)).toBe(join(tmpDir, 'requirements'));
  });

  it('prefers a closer requirements/ over a farther one (monorepo sub-package)', () => {
    mkdirSync(join(tmpDir, 'requirements'));
    const subPkg = join(tmpDir, 'pkg', 'app');
    mkdirSync(join(subPkg, 'requirements'), { recursive: true });
    expect(findArchiveDir(subPkg)).toBe(join(subPkg, 'requirements'));
  });

  it('stops at .git boundary (does not climb above the repo root)', () => {
    // tmpDir is the "outer system"; repoRoot has a .git dir; nothing under repo
    const repoRoot = join(tmpDir, 'repo');
    mkdirSync(join(repoRoot, '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'requirements')); // OUTSIDE the repo
    const sub = join(repoRoot, 'src');
    mkdirSync(sub, { recursive: true });
    expect(findArchiveDir(sub)).toBeNull();
  });

  it('returns null when no requirements/ anywhere up to root', () => {
    expect(findArchiveDir(tmpDir)).toBeNull();
  });

  it('attack: file (not directory) named requirements is ignored', () => {
    writeFileSync(join(tmpDir, 'requirements'), 'not a dir');
    expect(findArchiveDir(tmpDir)).toBeNull();
  });
});

describe('RequirementsArchiveProvider — basics', () => {
  it('id and displayName are stable', () => {
    const p = new RequirementsArchiveProvider();
    expect(p.id).toBe('requirements-archive');
    expect(p.displayName).toBe('Requirements Archive');
  });

  it('canHandle false when no requirements/ dir', () => {
    const p = new RequirementsArchiveProvider();
    expect(p.canHandle({ hostSessionId: 's', cwd: tmpDir })).toBe(false);
  });

  it('canHandle false when requirements/ exists but is empty', () => {
    mkdirSync(join(tmpDir, 'requirements'));
    const p = new RequirementsArchiveProvider();
    expect(p.canHandle({ hostSessionId: 's', cwd: tmpDir })).toBe(false);
  });

  it('canHandle true when requirements/ has at least one .md', () => {
    writeArchive(join(tmpDir, 'requirements'), '2026-05-04-x.md', '# X\n');
    const p = new RequirementsArchiveProvider();
    expect(p.canHandle({ hostSessionId: 's', cwd: tmpDir })).toBe(true);
  });

  it('attack: cwd missing → canHandle false', () => {
    const p = new RequirementsArchiveProvider();
    expect(p.canHandle({ hostSessionId: 's', cwd: '' })).toBe(false);
  });

  it('healthcheck always reports ok', async () => {
    const p = new RequirementsArchiveProvider();
    expect(await p.healthcheck()).toMatchObject({ ok: true });
  });
});

describe('RequirementsArchiveProvider — getSessionContext index', () => {
  it('returns markdown index of recent archives sorted by mtime desc', async () => {
    const dir = join(tmpDir, 'requirements');
    writeArchive(dir, '2026-04-01-old.md', '# Old\n## 目的\nold goal\n', 1000);
    writeArchive(dir, '2026-05-01-mid.md', '# Mid\n## 目的\nmid goal\n', 2000);
    writeArchive(dir, '2026-05-04-new.md', '# New\n## 目的\nnew goal\n', 3000);

    const p = new RequirementsArchiveProvider();
    const md = await p.getSessionContext({ hostSessionId: 's', cwd: tmpDir });
    expect(md).not.toBeNull();
    const lines = md!.split('\n').filter((l) => l.startsWith('-'));
    // Order: newest first
    expect(lines[0]).toContain('new');
    expect(lines[1]).toContain('mid');
    expect(lines[2]).toContain('old');
  });

  it('caps index entries to maxIndexEntries', async () => {
    const dir = join(tmpDir, 'requirements');
    for (let i = 0; i < 12; i++) {
      writeArchive(dir, `2026-05-0${(i % 9) + 1}-x${i}.md`, `# Item ${i}\n## 目的\ngoal ${i}\n`, 1000 + i);
    }
    const p = new RequirementsArchiveProvider({ maxIndexEntries: 3 });
    const md = (await p.getSessionContext({ hostSessionId: 's', cwd: tmpDir }))!;
    const bullets = md.split('\n').filter((l) => l.startsWith('-'));
    expect(bullets).toHaveLength(3);
  });

  it('archives without a parseable title are skipped from the index', async () => {
    const dir = join(tmpDir, 'requirements');
    writeArchive(dir, '2026-05-04-good.md', '# Good\n', 2000);
    writeArchive(dir, '2026-05-04-headless.md', 'just text, no heading\n', 1000);

    const p = new RequirementsArchiveProvider();
    const md = (await p.getSessionContext({ hostSessionId: 's', cwd: tmpDir }))!;
    expect(md).toContain('good');
    expect(md).not.toContain('headless');
  });

  it('returns null when no requirements/ dir', async () => {
    const p = new RequirementsArchiveProvider();
    expect(await p.getSessionContext({ hostSessionId: 's', cwd: tmpDir })).toBeNull();
  });

  it('falls back to mtime date when basename has no YYYY-MM-DD prefix', async () => {
    const dir = join(tmpDir, 'requirements');
    writeArchive(dir, 'no-date-prefix.md', '# T\n', 1717200000);
    const p = new RequirementsArchiveProvider();
    const md = (await p.getSessionContext({ hostSessionId: 's', cwd: tmpDir }))!;
    // mtime 1717200000s → 2024-06-01
    expect(md).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('RequirementsArchiveProvider — search', () => {
  function setup(): RequirementsArchiveProvider {
    const dir = join(tmpDir, 'requirements');
    writeArchive(dir, '2026-05-01-approval.md', `# Approval long-poll redesign

## 目的
Replace polling with EventBus wakeup so host_stop resolves promptly
when a Lark message arrives mid-poll.

## 关键决策与取舍
- Use SSE for renderer push; rejected long-polling on the renderer
- 10min default budget for host_stop
`, 2000);
    writeArchive(dir, '2026-05-04-binding.md', `# Lark bind handshake

## 目的
6-character hex code with 10-minute TTL. Desktop UI consumes pending_binds.

## 改动文件
- src/app/lark-wiring.ts
- src/storage/repos/channel-bindings.ts
`, 3000);
    writeArchive(dir, '2026-04-15-misc.md', `# Misc cleanup

## 目的
Tidy logger output and bump tsconfig strict.
`, 1000);
    return new RequirementsArchiveProvider();
  }

  it('returns empty when query is empty / whitespace-only', async () => {
    const p = setup();
    expect(await p.search('', { hostSessionId: 's', cwd: tmpDir })).toEqual([]);
    expect(await p.search('   ', { hostSessionId: 's', cwd: tmpDir })).toEqual([]);
  });

  it('returns empty when no requirements/ dir', async () => {
    const p = new RequirementsArchiveProvider();
    expect(await p.search('approval', { hostSessionId: 's', cwd: tmpDir })).toEqual([]);
  });

  it('ranks title hits above body hits', async () => {
    const p = setup();
    const r = await p.search('approval', { hostSessionId: 's', cwd: tmpDir });
    expect(r[0]?.title).toContain('Approval');
    expect(r[0]?.score).toBeGreaterThan(r[1]?.score ?? 0);
  });

  it('multi-token query — best matching paragraph as snippet', async () => {
    const p = setup();
    const r = await p.search('hex code TTL', { hostSessionId: 's', cwd: tmpDir });
    expect(r[0]?.title).toContain('bind handshake');
    expect(r[0]?.body).toContain('hex');
  });

  it('citation references the basename', async () => {
    const p = setup();
    const r = await p.search('approval', { hostSessionId: 's', cwd: tmpDir });
    expect(r[0]?.citation).toBe('requirements:2026-05-01-approval');
  });

  it('caps results to maxSearchResults', async () => {
    const dir = join(tmpDir, 'requirements');
    rmSync(dir, { recursive: true, force: true });
    for (let i = 0; i < 8; i++) {
      writeArchive(dir, `2026-05-0${(i % 9) + 1}-i${i}.md`, `# Item ${i}\nlark message arrived\n`);
    }
    const p = new RequirementsArchiveProvider({ maxSearchResults: 3 });
    const r = await p.search('lark message', { hostSessionId: 's', cwd: tmpDir });
    expect(r).toHaveLength(3);
  });

  it('attack: archives with zero overlap are filtered out (not zero-score noise)', async () => {
    const p = setup();
    const r = await p.search('binding', { hostSessionId: 's', cwd: tmpDir });
    // "approval" archive has nothing about binding → filtered out
    expect(r.every((s) => (s.score ?? 0) > 0)).toBe(true);
    expect(r.some((s) => s.title.includes('Approval long-poll'))).toBe(false);
  });

  it('attack: query with only short tokens returns empty (1-char tokens dropped)', async () => {
    const p = setup();
    expect(await p.search('a x', { hostSessionId: 's', cwd: tmpDir })).toEqual([]);
  });

  it('attack: malformed archive (no title) still searched, surfaces basename as title', async () => {
    writeArchive(join(tmpDir, 'requirements'), 'broken.md', 'lark message lark message lark', 5000);
    // setup() has 3 archives already; recreate to avoid pre-test interference.
    const p = new RequirementsArchiveProvider();
    const r = await p.search('lark', { hostSessionId: 's', cwd: tmpDir });
    expect(r.length).toBeGreaterThan(0);
    const broken = r.find((s) => s.citation === 'requirements:broken');
    expect(broken).toBeDefined();
  });

  it('snippet truncates to snippetMaxBytes', async () => {
    const dir = join(tmpDir, 'requirements');
    rmSync(dir, { recursive: true, force: true });
    const longPara = 'lark ' + 'x'.repeat(500);
    writeArchive(dir, '2026-05-04-long.md', `# Long\n\n${longPara}\n`);
    const p = new RequirementsArchiveProvider({ snippetMaxBytes: 100 });
    const r = await p.search('lark', { hostSessionId: 's', cwd: tmpDir });
    expect(r[0]?.body.length).toBeLessThanOrEqual(100);
    expect(r[0]?.body.endsWith('…')).toBe(true);
  });
});
