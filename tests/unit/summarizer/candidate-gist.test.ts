import { createHash, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import {
  getCandidateById,
  insertCandidateIfNew,
} from '../../../src/storage/repos/knowledge-candidates.js';
import {
  generateCandidateGist,
  parseGistResponse,
} from '../../../src/summarizer/candidate-gist.js';
import type { KnowledgeCandidate } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  upsertRole(db, { id: 'r1', name: 'r1', systemPrompt: 'p', isBuiltin: false, createdAt: 't' });
  return db;
}

function makeCandidate(text = `body ${randomUUID()}`): KnowledgeCandidate {
  return {
    id: randomUUID(),
    roleId: 'r1',
    chunkText: text,
    sourceSegmentIndex: 0,
    kind: 'other',
    scoreEntity: 2,
    scoreCosine: 0.3,
    textHash: createHash('sha256').update(text).digest('hex'),
    status: 'pending',
    createdAt: '2026-06-09T10:00:00.000Z',
    provenance: 'chat_capture',
  };
}

describe('parseGistResponse', () => {
  it('parses kind + gist on two clean lines', () => {
    expect(parseGistResponse('kind: warning\ngist: hdiutil flakes but .app still ships'))
      .toEqual({ kind: 'warning', gist: 'hdiutil flakes but .app still ships' });
  });

  it('tolerates surrounding preamble', () => {
    expect(parseGistResponse('Sure, here:\nkind: example\ngist: cp dist/ /Applications\nLet me know!'))
      .toEqual({ kind: 'example', gist: 'cp dist/ /Applications' });
  });

  it('accepts halfwidth or fullwidth colons', () => {
    expect(parseGistResponse('kind：spec\ngist：don\'t do X'))
      .toEqual({ kind: 'spec', gist: "don't do X" });
  });

  it('returns null when kind isn\'t in the taxonomy', () => {
    expect(parseGistResponse('kind: decision\ngist: ship X')).toBeNull();
  });

  it('returns null when gist is missing', () => {
    expect(parseGistResponse('kind: warning')).toBeNull();
  });

  it('returns null when kind is missing', () => {
    expect(parseGistResponse('gist: do not commit secrets')).toBeNull();
  });

  it('caps gist at 200 chars', () => {
    const long = 'x'.repeat(500);
    const parsed = parseGistResponse(`kind: other\ngist: ${long}`)!;
    expect(parsed.gist.length).toBe(200);
  });
});

describe('generateCandidateGist (integration)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('writes gist + kind onto the row on LLM success', async () => {
    const c = makeCandidate('cp dist/mac-arm64/helm.app /Applications/');
    insertCandidateIfNew(db, c);
    const llm = { generate: vi.fn(async () => 'kind: example\ngist: install command') };
    const result = await generateCandidateGist(db, c.id, { llm });
    expect(result).toEqual({ kind: 'example', gist: 'install command' });
    const row = getCandidateById(db, c.id)!;
    expect(row.kind).toBe('example');
    expect(row.gist).toBe('install command');
  });

  it('returns null + leaves the row untouched when LLM throws', async () => {
    const c = makeCandidate();
    insertCandidateIfNew(db, c);
    const llm = { generate: vi.fn(async () => { throw new Error('boom'); }) };
    expect(await generateCandidateGist(db, c.id, { llm })).toBeNull();
    const row = getCandidateById(db, c.id)!;
    expect(row.gist).toBeUndefined();
    expect(row.kind).toBe('other'); // unchanged from insert default
  });

  it('returns null when the candidate id does not exist', async () => {
    const llm = { generate: vi.fn(async () => 'kind: spec\ngist: x') };
    expect(await generateCandidateGist(db, 'ghost-id', { llm })).toBeNull();
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it('returns null + leaves the row untouched when LLM output is unparseable', async () => {
    const c = makeCandidate();
    insertCandidateIfNew(db, c);
    const llm = { generate: vi.fn(async () => 'I have no idea what this is') };
    expect(await generateCandidateGist(db, c.id, { llm })).toBeNull();
    expect(getCandidateById(db, c.id)!.gist).toBeUndefined();
  });
});
