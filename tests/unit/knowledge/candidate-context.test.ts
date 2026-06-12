/**
 * PR-β: candidate external-context cache — prefetch, upsert, batch read.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  fetchAndCacheCandidateContext,
  getCandidateContext,
  getCandidateContexts,
} from '../../../src/knowledge/candidate-context.js';
import { KnowledgeProviderRegistry } from '../../../src/knowledge/types.js';
import type { KnowledgeProvider, KnowledgeSnippet } from '../../../src/knowledge/types.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { writeCandidateIfNew } from '../../../src/capture/candidate-writer.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function fakeProvider(id: string, snippets: KnowledgeSnippet[]): KnowledgeProvider {
  return {
    id,
    displayName: id,
    canHandle: () => true,
    getSessionContext: async () => null,
    search: async () => snippets,
    healthcheck: async () => ({ ok: true }),
  };
}

function seedCandidate(db: BetterSqlite3.Database, id: string): string {
  upsertRole(db, {
    id: 'og', name: 'OG', systemPrompt: '',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  const r = writeCandidateIfNew(db, {
    roleId: 'og',
    chunkText: `OG schema 回退约定 ${id}`,
    sourceSegmentIndex: 0,
    kind: 'other',
    scoreEntity: 2,
    scoreCosine: 0,
    createdAt: new Date().toISOString(),
  });
  return r.candidate.id;
}

describe('candidate external context', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('fetches, merges with source prefixes, caches, and re-reads', async () => {
    const candidateId = seedCandidate(db, 'a');
    const registry = new KnowledgeProviderRegistry();
    registry.register(fakeProvider('tika', [
      { source: 'tika', title: 'OG 指南', body: 'OG 标签要先注册。' },
    ]));

    const ctx = await fetchAndCacheCandidateContext(db, registry, {
      candidateId, queryText: 'OG schema 回退',
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.providers).toEqual(['tika']);
    expect(ctx!.body).toContain('【tika】');
    expect(ctx!.body).toContain('OG 标签要先注册');

    const read = getCandidateContext(db, candidateId);
    expect(read?.body).toBe(ctx!.body);
  });

  it('upsert: a refresh replaces the previous row', async () => {
    const candidateId = seedCandidate(db, 'b');
    const registry = new KnowledgeProviderRegistry();
    const provider = fakeProvider('kb', [{ source: 'kb', title: 't', body: 'v1' }]);
    registry.register(provider);
    await fetchAndCacheCandidateContext(db, registry, { candidateId, queryText: 'q' });

    registry.unregister('kb');
    registry.register(fakeProvider('kb', [{ source: 'kb', title: 't', body: 'v2 updated' }]));
    const ctx2 = await fetchAndCacheCandidateContext(db, registry, { candidateId, queryText: 'q' });
    expect(ctx2!.body).toContain('v2 updated');
    expect(getCandidateContext(db, candidateId)!.body).toContain('v2 updated');
  });

  it('empty provider results cache nothing (later refresh can retry)', async () => {
    const candidateId = seedCandidate(db, 'c');
    const registry = new KnowledgeProviderRegistry();
    registry.register(fakeProvider('kb', []));
    const ctx = await fetchAndCacheCandidateContext(db, registry, { candidateId, queryText: 'q' });
    expect(ctx).toBeNull();
    expect(getCandidateContext(db, candidateId)).toBeUndefined();
  });

  it('provider filter limits which sources are asked', async () => {
    const candidateId = seedCandidate(db, 'd');
    const registry = new KnowledgeProviderRegistry();
    registry.register(fakeProvider('tika', [{ source: 'tika', title: 't', body: 'tika says' }]));
    registry.register(fakeProvider('noisy', [{ source: 'noisy', title: 'n', body: 'noise' }]));
    const ctx = await fetchAndCacheCandidateContext(db, registry, {
      candidateId, queryText: 'q', providers: ['tika'],
    });
    expect(ctx!.providers).toEqual(['tika']);
    expect(ctx!.body).not.toContain('noise');
  });

  it('batch read returns only candidates with cached rows', async () => {
    const a = seedCandidate(db, 'e');
    const b = seedCandidate(db, 'f');
    const registry = new KnowledgeProviderRegistry();
    registry.register(fakeProvider('kb', [{ source: 'kb', title: 't', body: 'x' }]));
    await fetchAndCacheCandidateContext(db, registry, { candidateId: a, queryText: 'q' });
    const map = getCandidateContexts(db, [a, b, 'missing']);
    expect(Object.keys(map)).toEqual([a]);
  });

  it('rows cascade away with the candidate', async () => {
    const candidateId = seedCandidate(db, 'g');
    const registry = new KnowledgeProviderRegistry();
    registry.register(fakeProvider('kb', [{ source: 'kb', title: 't', body: 'x' }]));
    await fetchAndCacheCandidateContext(db, registry, { candidateId, queryText: 'q' });
    db.prepare(`DELETE FROM knowledge_candidates WHERE id = ?`).run(candidateId);
    expect(getCandidateContext(db, candidateId)).toBeUndefined();
  });
});
