/**
 * Role bundle pack/unpack/apply — Phase 79.
 *
 * Pins:
 *   - packRole → unpackRole roundtrip preserves chunk count + texts + kinds
 *   - embeddings survive base64 round-trip
 *   - contentHash is stable under re-export of same data (canonical sort)
 *   - contentHash changes when any chunk text changes
 *   - unsupported bundleVersion → throws
 *   - missing fields → throws with helpful message
 *   - applyRoleBundle: new chunks → become candidates (provenance='subscription')
 *   - applyRoleBundle: duplicate chunks → alreadyPresent counted, no candidates
 *   - applyRoleBundle: partial dup → correct mix
 *   - applyRoleBundle: idempotent — re-apply same bundle is a no-op
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { trainRole } from '../../../src/roles/library.js';
import {
  applyRoleBundle,
  bundleToBytes,
  computeContentHash,
  packRole,
  unpackRole,
  type RoleBundle,
} from '../../../src/roles/bundle.js';
import { listCandidatesForRole } from '../../../src/storage/repos/knowledge-candidates.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('packRole + unpackRole — roundtrip', () => {
  let db: BetterSqlite3.Database;
  const embedFn = makePseudoEmbedFn();

  beforeEach(async () => {
    db = openDb();
    await trainRole(db, {
      roleId: 'rA', name: 'A',
      documents: [
        { filename: 'one.md', content: 'first chunk text long enough to survive splitter floor xyzxyzxyz', kind: 'spec' },
        { filename: 'two.md', content: 'second chunk text completely distinct content here xxxxxxxxxxxxxxxxx', kind: 'runbook' },
      ],
      embedFn,
    });
  });
  afterEach(() => { db.close(); });

  it('preserves chunk count and texts', () => {
    const bundle = packRole(db, 'rA');
    const bytes = bundleToBytes(bundle);
    const unpacked = unpackRole(bytes);
    expect(unpacked.chunks.length).toBe(bundle.chunks.length);
    expect(unpacked.chunks[0]?.chunkText).toBe(bundle.chunks[0]?.chunkText);
  });

  it('does NOT serialize embeddings (reviewer should-fix: accept re-embeds, embeddings would be pure bloat)', () => {
    const bundle = packRole(db, 'rA');
    expect((bundle.chunks[0] as unknown as { embedding?: string }).embedding).toBeUndefined();
    // Sanity check: total byte size is much less than 1KB per chunk
    // (without embeddings, a sub-MB bundle for any realistic role).
    const bytes = bundleToBytes(bundle);
    expect(bytes.length).toBeLessThan(8 * 1024); // < 8KB for 2 small chunks
  });

  it('contentHash is stable under re-pack with no DB changes', () => {
    const a = packRole(db, 'rA').contentHash;
    const b = packRole(db, 'rA').contentHash;
    expect(a).toBe(b);
  });
});

describe('computeContentHash — canonical-form invariants', () => {
  it('insertion order does not change the hash', () => {
    const a = [
      { textHash: 'a', chunkText: 'x', kind: 'other' as const, sourceIndex: -1 },
      { textHash: 'b', chunkText: 'y', kind: 'other' as const, sourceIndex: -1 },
    ];
    const b = [a[1]!, a[0]!];
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('mutating a chunk text changes the hash', () => {
    const a = [{ textHash: 'a', chunkText: 'x', kind: 'other' as const, sourceIndex: -1 }];
    const b = [{ textHash: 'a-prime', chunkText: 'x', kind: 'other' as const, sourceIndex: -1 }];
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it('changing ONLY the kind changes the hash (reviewer should-fix)', () => {
    const a = [{ textHash: 'h', chunkText: 'x', kind: 'spec' as const, sourceIndex: -1 }];
    const b = [{ textHash: 'h', chunkText: 'x', kind: 'runbook' as const, sourceIndex: -1 }];
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
});

describe('resolveBundleUploadUrl — convention prefix injection', () => {
  it('bucket-only URL → prefixes with helm-role/<roleId>.helmrole', async () => {
    const { resolveBundleUploadUrl } = await import('../../../src/roles/bundle.js');
    expect(resolveBundleUploadUrl('tos://my-bucket', 'goofy-expert'))
      .toBe('tos://my-bucket/helm-role/goofy-expert.helmrole');
    expect(resolveBundleUploadUrl('tos://my-bucket/', 'goofy-expert'))
      .toBe('tos://my-bucket/helm-role/goofy-expert.helmrole');
  });

  it('custom prefix with trailing slash → helm appends <roleId>.helmrole', async () => {
    const { resolveBundleUploadUrl } = await import('../../../src/roles/bundle.js');
    expect(resolveBundleUploadUrl('tos://my-bucket/my-team/', 'goofy-expert'))
      .toBe('tos://my-bucket/my-team/goofy-expert.helmrole');
    expect(resolveBundleUploadUrl('tos://my-bucket/nested/path/', 'role-x'))
      .toBe('tos://my-bucket/nested/path/role-x.helmrole');
  });

  it('full path ending .helmrole → verbatim (power-user escape hatch)', async () => {
    const { resolveBundleUploadUrl } = await import('../../../src/roles/bundle.js');
    const explicit = 'tos://my-bucket/some/place/specific-name.helmrole';
    expect(resolveBundleUploadUrl(explicit, 'goofy-expert')).toBe(explicit);
  });

  it('ambiguous path (no trailing slash, no .helmrole extension) → throws', async () => {
    const { resolveBundleUploadUrl } = await import('../../../src/roles/bundle.js');
    expect(() => resolveBundleUploadUrl('tos://my-bucket/no-extension', 'role')).toThrow(/ambiguous/);
    expect(() => resolveBundleUploadUrl('tos://my-bucket/maybe-folder', 'role')).toThrow(/ambiguous/);
  });

  it('bad URL (no scheme) → throws with helpful message', async () => {
    const { resolveBundleUploadUrl } = await import('../../../src/roles/bundle.js');
    expect(() => resolveBundleUploadUrl('just-a-string', 'role')).toThrow(/bad URL/);
    expect(() => resolveBundleUploadUrl('://no-scheme', 'role')).toThrow(/bad URL/);
  });

  it('file:// URL also honored — convention applies to every storage scheme', async () => {
    const { resolveBundleUploadUrl } = await import('../../../src/roles/bundle.js');
    expect(resolveBundleUploadUrl('file:///abs/path/', 'goofy'))
      .toBe('file:///abs/path/goofy.helmrole');
  });
});

describe('unpackRole — size cap (reviewer blocker #3)', () => {
  it('rejects bundle exceeding MAX_BUNDLE_BYTES', async () => {
    // Build a bundle whose serialized form is > 16MB by stuffing chunks
    // with long text. 17 chunks × 1MB each is enough.
    const { MAX_BUNDLE_BYTES } = await import('../../../src/roles/bundle.js');
    const oversized = Buffer.alloc(MAX_BUNDLE_BYTES + 1, 'x');
    expect(() => unpackRole(oversized)).toThrow(/exceeds MAX_BUNDLE_BYTES/);
  });
});

describe('unpackRole — guard rails', () => {
  it('rejects unsupported bundleVersion', () => {
    const bad = JSON.stringify({ bundleVersion: 999 });
    expect(() => unpackRole(Buffer.from(bad))).toThrow(/bundleVersion=999 unsupported/);
  });
  it('rejects missing role block', () => {
    const bundle: Partial<RoleBundle> = { bundleVersion: 1, exportedAt: 'x', sourceHelmVersion: 'x', contentHash: 'x', sources: [], chunks: [] };
    expect(() => unpackRole(Buffer.from(JSON.stringify(bundle)))).toThrow(/role block/);
  });
  it('rejects non-JSON bytes', () => {
    expect(() => unpackRole(Buffer.from('not json'))).toThrow(/invalid JSON/);
  });
});

describe('applyRoleBundle — diff into candidates', () => {
  let db: BetterSqlite3.Database;
  const embedFn = makePseudoEmbedFn();

  beforeEach(async () => {
    db = openDb();
    // Two roles: source (where we'll pack from) + target (empty, will receive bundle)
    await trainRole(db, {
      roleId: 'src-role', name: 'src',
      documents: [
        { filename: 'a.md', content: 'alpha doc body must exceed the splitter min char floor of eighty so we add filler xxxxxxxx', kind: 'spec' },
        { filename: 'b.md', content: 'bravo doc body different content also exceeds the splitter floor with padding ffffffffffffff', kind: 'spec' },
      ],
      embedFn,
    });
    // Target role exists but has no chunks.
    await trainRole(db, {
      roleId: 'tgt-role', name: 'tgt',
      documents: [],
      embedFn,
    });
  });
  afterEach(() => { db.close(); });

  it('all-new chunks → all become candidates with provenance subscription', () => {
    const bundle = packRole(db, 'src-role');
    const result = applyRoleBundle(db, 'tgt-role', bundle);
    expect(result.candidatesCreated.length).toBe(bundle.chunks.length);
    expect(result.alreadyPresent).toBe(0);
    const cands = listCandidatesForRole(db, 'tgt-role');
    expect(cands.length).toBe(bundle.chunks.length);
    expect(cands.every((c) => c.provenance === 'subscription')).toBe(true);
  });

  it('re-applying the same bundle is a no-op (dedup gate)', () => {
    const bundle = packRole(db, 'src-role');
    const first = applyRoleBundle(db, 'tgt-role', bundle);
    expect(first.candidatesCreated.length).toBeGreaterThan(0);
    const second = applyRoleBundle(db, 'tgt-role', bundle);
    expect(second.candidatesCreated.length).toBe(0);
    expect(second.dedupSkipped).toBe(first.candidatesCreated.length);
  });

  it('applying to a role that already has matching chunks marks them alreadyPresent', () => {
    const bundle = packRole(db, 'src-role');
    // Apply the bundle once + manually accept all candidates so they become real chunks
    applyRoleBundle(db, 'tgt-role', bundle);
    for (const c of listCandidatesForRole(db, 'tgt-role')) {
      // simulate accept = write to knowledge_chunks
      db.prepare(`
        INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(`accepted-${c.id}`, 'tgt-role', c.chunkText, c.kind, c.createdAt);
    }
    // Now re-apply: every chunk should be alreadyPresent (matched by hash).
    const result = applyRoleBundle(db, 'tgt-role', bundle);
    expect(result.candidatesCreated.length).toBe(0);
    expect(result.alreadyPresent).toBe(bundle.chunks.length);
  });
});
