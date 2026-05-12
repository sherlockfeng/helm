/**
 * Roles library — built-in seeding + custom-role training + RAG search.
 *
 * Ported from relay/src/roles/library.ts. The only structural change is that
 * we use the function-style storage repos (storage/repos/roles.ts) instead of
 * relay's class-based AgentForgeDB methods.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  deleteChunksForRole,
  getChunksForRole,
  getRole as getRoleRow,
  getSourceByFingerprint,
  insertChunk,
  insertSource,
  listRoles as listRoleRows,
  upsertRole,
} from '../storage/repos/roles.js';
import type {
  KnowledgeChunk,
  KnowledgeChunkKind,
  KnowledgeSource,
  KnowledgeSourceKind,
  Role,
} from '../storage/types.js';
import { PRODUCT_SYSTEM_PROMPT } from './builtin/product.js';
import { DEVELOPER_SYSTEM_PROMPT } from './builtin/developer.js';
import { TESTER_SYSTEM_PROMPT } from './builtin/tester.js';

const BUILTIN_ROLES: Omit<Role, 'createdAt'>[] = [
  { id: 'product', name: 'Product Agent', systemPrompt: PRODUCT_SYSTEM_PROMPT, docPath: 'docs/roles/product.md', isBuiltin: true },
  { id: 'developer', name: 'Developer Agent', systemPrompt: DEVELOPER_SYSTEM_PROMPT, docPath: 'docs/roles/developer.md', isBuiltin: true },
  { id: 'tester', name: 'Test Agent', systemPrompt: TESTER_SYSTEM_PROMPT, docPath: 'docs/roles/tester.md', isBuiltin: true },
];

export function seedBuiltinRoles(db: Database.Database): void {
  const now = new Date().toISOString();
  for (const r of BUILTIN_ROLES) {
    upsertRole(db, { ...r, createdAt: now });
  }
}

export function getRole(db: Database.Database, roleId: string): Role {
  const role = getRoleRow(db, roleId);
  if (!role) throw new Error(`Role not found: ${roleId}`);
  return role;
}

export function listRoles(db: Database.Database): Role[] {
  return listRoleRows(db);
}

/**
 * Phase 73: input document carries optional `kind` (chunk type) +
 * optional `sourceKind` / `origin` (provenance). When sourceKind/origin
 * are omitted, the library infers — a URL filename → `lark-doc`, a path
 * with `/` → `file`, otherwise → `inline`. The `kind` defaults to
 * `'other'` so existing callers keep working.
 */
export interface TrainRoleDocument {
  filename: string;
  content: string;
  /** Chunk discriminator — propagated to every chunk this doc produces. */
  kind?: KnowledgeChunkKind;
  /** Source row's `kind` — defaults inferred from `filename` shape. */
  sourceKind?: KnowledgeSourceKind;
  /** Source row's `origin` (URL / abs path / inline pseudo-id). Defaults to `filename`. */
  origin?: string;
  /** Optional human-readable label stamped on the source row. */
  sourceLabel?: string;
}

export interface TrainRoleInput {
  roleId: string;
  name: string;
  documents: TrainRoleDocument[];
  baseSystemPrompt?: string;
  embedFn: (text: string) => Promise<Float32Array>;
}

/**
 * Phase 73: per-input materialization plan. Each TrainRoleDocument resolves
 * to one source row (new or reused by fingerprint) plus its chunks. We
 * compute this up-front so trainRole / updateRole both share the same
 * source-id allocation logic.
 */
function fingerprintDoc(filename: string, content: string): string {
  return createHash('sha256').update(`${filename}\n${content}`).digest('hex');
}

function inferSourceKind(filename: string): KnowledgeSourceKind {
  if (/^https?:\/\//i.test(filename)) return 'lark-doc';
  if (filename.includes('/')) return 'file';
  return 'inline';
}

/**
 * Phase 73: returns the source row for this doc (creating it if no row
 * with the same fingerprint exists in this role). Idempotent for the
 * "user re-trains the same doc" case — see Decision §C in the task doc
 * for why we still let chunks get re-inserted alongside the reused
 * source row instead of dedup'ing.
 */
function ensureSource(
  db: Database.Database,
  roleId: string,
  doc: TrainRoleDocument,
  now: string,
): KnowledgeSource {
  const fp = fingerprintDoc(doc.filename, doc.content);
  const existing = getSourceByFingerprint(db, roleId, fp);
  if (existing) return existing;
  const sourceKind = doc.sourceKind ?? inferSourceKind(doc.filename);
  const row: KnowledgeSource = {
    id: randomUUID(),
    roleId,
    kind: sourceKind,
    origin: doc.origin ?? doc.filename,
    fingerprint: fp,
    createdAt: now,
  };
  if (doc.sourceLabel) row.label = doc.sourceLabel;
  insertSource(db, row);
  return row;
}

export async function trainRole(db: Database.Database, input: TrainRoleInput): Promise<Role> {
  const now = new Date().toISOString();
  const existing = getRoleRow(db, input.roleId);

  const systemPrompt = input.baseSystemPrompt
    ?? existing?.systemPrompt
    ?? `You are a specialized expert agent with deep knowledge of ${input.name}. Use your knowledge base to answer questions and assist with tasks related to this domain.`;

  upsertRole(db, {
    id: input.roleId,
    name: input.name,
    systemPrompt,
    isBuiltin: false,
    createdAt: now,
  });

  // Phase 73: full-replace wipes the role's existing chunks. Sources from
  // previous trainRole calls also become orphans — drop them, because the
  // user has explicitly asked to rebuild this role from these documents.
  // (updateRole's append mode is the path that preserves prior state.)
  deleteChunksForRole(db, input.roleId);
  db.prepare(`DELETE FROM knowledge_sources WHERE role_id = ?`).run(input.roleId);

  for (const doc of input.documents) {
    const source = ensureSource(db, input.roleId, doc, now);
    const chunks = chunkDocument(doc.content, doc.filename);
    for (const chunk of chunks) {
      const embedding = await input.embedFn(chunk.text);
      const row: KnowledgeChunk = {
        id: randomUUID(),
        roleId: input.roleId,
        sourceFile: doc.filename,
        chunkText: chunk.text,
        embedding,
        kind: doc.kind ?? 'other',
        sourceId: source.id,
        createdAt: now,
      };
      insertChunk(db, row);
    }
  }

  const refreshed = getRoleRow(db, input.roleId);
  if (!refreshed) throw new Error(`trainRole: role disappeared after upsert: ${input.roleId}`);
  return refreshed;
}

/**
 * Phase 65/66: incremental update for an existing role. Differs from
 * `trainRole` (Phase 7) which is a full replace:
 *
 *   - **`appendDocuments`** chunks new content and INSERTs alongside the
 *     existing knowledge — old chunks are kept. Use this for "I learned
 *     three new things about TCE today, append them" without wiping the
 *     50 chunks already in the role.
 *   - **`name` / `baseSystemPrompt`** UPDATE the corresponding role
 *     fields. Either may be omitted to keep the existing value.
 *   - At least one of {appendDocuments, baseSystemPrompt, name} must be
 *     provided — empty input throws so the caller can't silently no-op.
 *
 * Phase 66: when `appendDocuments` is given, helm runs an explicit
 * **comparison step** first — each new chunk is embedded and compared
 * against every existing chunk's embedding (cosine similarity). Any pair
 * with similarity ≥ `CONFLICT_THRESHOLD` is flagged as a "conflict" and
 * the result is returned WITHOUT writing to the DB, so the caller can
 * surface those overlaps to the user for confirmation. Pass `force: true`
 * to skip detection (e.g. after the user has decided to keep both
 * versions, or after they've called `deleteChunkById` to remove the old
 * one).
 *
 * Returns one of two shapes (discriminated union on `status`):
 *   - `{ status: 'applied', role, chunksAdded }`     — DB was written
 *   - `{ status: 'conflicts', conflicts: [...] }`    — nothing written;
 *     caller must resolve and retry with `force: true` (or after deleting
 *     the conflicting old chunks via `deleteChunkById`).
 *
 * Note: name / baseSystemPrompt updates are NEVER blocked by conflicts —
 * conflicts are a property of the chunk knowledge base, not the role
 * metadata. A pure prompt-rename update has nothing to conflict with so
 * it always lands as `'applied'`.
 */
export interface UpdateRoleInput {
  roleId: string;
  /** New display name. Omit to keep existing. */
  name?: string;
  /** New system prompt. Omit to keep existing. */
  baseSystemPrompt?: string;
  /** Documents to chunk + APPEND. Existing chunks stay. Phase 73: now
   * carries the same `TrainRoleDocument` shape (with optional `kind` /
   * `sourceKind` / `origin` / `sourceLabel`). */
  appendDocuments?: TrainRoleDocument[];
  embedFn: (text: string) => Promise<Float32Array>;
  /**
   * Phase 66: skip conflict detection and append unconditionally. Pass
   * `true` after the user has reviewed conflicts and chosen to either (a)
   * keep both versions or (b) delete the colliding old chunk via
   * `deleteChunkById` and re-call.
   */
  force?: boolean;
}

/** Phase 66: a flagged overlap between a new chunk and an existing chunk. */
export interface ChunkConflict {
  /** Existing chunk ID — pass to deleteChunkById if the user wants to replace. */
  existingChunkId: string;
  existingChunkText: string;
  existingSourceFile?: string;
  /** Index of the conflicting new doc in `appendDocuments`. */
  newDocIndex: number;
  newDocFilename: string;
  newChunkText: string;
  /** Cosine similarity (1 = identical). */
  similarity: number;
}

export type UpdateRoleResult =
  | { status: 'applied'; role: Role; chunksAdded: number }
  | { status: 'conflicts'; conflicts: ChunkConflict[] };

/**
 * Phase 66: similarity at or above this counts as a conflict needing user
 * confirmation. 0.85 is empirically a good cut for the pseudo-embedder
 * (token-bag) — paraphrases of the same fact land >0.9, while genuinely
 * unrelated docs sit <0.5. If we swap in a real embedder later, this
 * threshold may need to retune.
 */
export const CONFLICT_THRESHOLD = 0.85;

export async function updateRole(
  db: Database.Database,
  input: UpdateRoleInput,
): Promise<UpdateRoleResult> {
  const existing = getRoleRow(db, input.roleId);
  if (!existing) {
    throw new Error(`updateRole: role not found: ${input.roleId}. Use train_role to create new roles.`);
  }

  const docs = input.appendDocuments ?? [];
  if (input.name === undefined && input.baseSystemPrompt === undefined && docs.length === 0) {
    throw new Error('updateRole: nothing to update — pass at least one of name / baseSystemPrompt / appendDocuments');
  }

  // Phase 66: pre-embed new chunks once. We need them for both the
  // conflict scan AND (if we proceed) the actual insert, so doing it
  // upfront avoids re-running the embedder.
  // Phase 73: also carry the parent doc's kind so the chunk-write step
  // (which lives after the conflict gate) can propagate it.
  const newChunks: Array<{
    docIndex: number;
    filename: string;
    text: string;
    embedding: Float32Array;
    kind: KnowledgeChunkKind;
  }> = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const kind: KnowledgeChunkKind = doc.kind ?? 'other';
    for (const chunk of chunkDocument(doc.content, doc.filename)) {
      newChunks.push({
        docIndex: i,
        filename: doc.filename,
        text: chunk.text,
        embedding: await input.embedFn(chunk.text),
        kind,
      });
    }
  }

  // Phase 66: comparison step. Skip when force=true (caller has already
  // resolved) or when there are no docs (prompt/name-only update has
  // nothing to compare).
  if (!input.force && newChunks.length > 0) {
    const conflicts = findConflictingChunks(db, existing.id, newChunks);
    if (conflicts.length > 0) {
      // IMPORTANT: do NOT write anything to the DB here. The whole point
      // of detection is "ask first, write later". Even the name /
      // baseSystemPrompt update is held back so the user gets one
      // coherent confirmation moment instead of partial state.
      return { status: 'conflicts', conflicts };
    }
  }

  const now = new Date().toISOString();

  // Field-level update — only touch what the caller specified, so a name-
  // only update doesn't accidentally null the system prompt.
  if (input.name !== undefined || input.baseSystemPrompt !== undefined) {
    upsertRole(db, {
      id: existing.id,
      name: input.name ?? existing.name,
      systemPrompt: input.baseSystemPrompt ?? existing.systemPrompt,
      isBuiltin: existing.isBuiltin,
      createdAt: existing.createdAt,
    });
  }

  // Phase 73: materialize source rows for each input doc. Same-fingerprint
  // reuses (per Decision §6); new fingerprint creates a new row. We need
  // these BEFORE chunk insert so each chunk gets its source_id.
  const sourceByDocIndex = new Map<number, KnowledgeSource>();
  for (let i = 0; i < docs.length; i++) {
    sourceByDocIndex.set(i, ensureSource(db, existing.id, docs[i]!, now));
  }

  // Append chunks — DO NOT call deleteChunksForRole. That's the entire
  // point: existing knowledge survives.
  let chunksAdded = 0;
  for (const c of newChunks) {
    const source = sourceByDocIndex.get(c.docIndex)!;
    const row: KnowledgeChunk = {
      id: randomUUID(),
      roleId: existing.id,
      sourceFile: c.filename,
      chunkText: c.text,
      embedding: c.embedding,
      kind: c.kind,
      sourceId: source.id,
      createdAt: now,
    };
    insertChunk(db, row);
    chunksAdded += 1;
  }

  const refreshed = getRoleRow(db, existing.id);
  if (!refreshed) throw new Error(`updateRole: role disappeared after update: ${existing.id}`);
  return { status: 'applied', role: refreshed, chunksAdded };
}

/**
 * Phase 66: scan a role's existing chunks against a batch of pre-embedded
 * new chunks. For each new chunk, the highest-scoring existing chunk
 * above {@link CONFLICT_THRESHOLD} is reported (one entry per overlapping
 * new chunk, not per pair — keeps the user-facing list tight).
 *
 * Existing chunks without an embedding (legacy rows) are skipped: we
 * can't compare them, so we err on the side of "no conflict" and let
 * the append proceed. That's the same fail-open behavior `searchKnowledge`
 * uses.
 */
export function findConflictingChunks(
  db: Database.Database,
  roleId: string,
  newChunks: Array<{
    docIndex: number;
    filename: string;
    text: string;
    embedding: Float32Array;
  }>,
): ChunkConflict[] {
  const existing = getChunksForRole(db, roleId).filter((c) => c.embedding != null);
  if (existing.length === 0) return [];

  const conflicts: ChunkConflict[] = [];
  for (const nc of newChunks) {
    let best: { chunk: KnowledgeChunk; score: number } | null = null;
    for (const ec of existing) {
      const score = cosineSimilarity(nc.embedding, ec.embedding!);
      if (score >= CONFLICT_THRESHOLD && (!best || score > best.score)) {
        best = { chunk: ec, score };
      }
    }
    if (best) {
      conflicts.push({
        existingChunkId: best.chunk.id,
        existingChunkText: best.chunk.chunkText,
        ...(best.chunk.sourceFile ? { existingSourceFile: best.chunk.sourceFile } : {}),
        newDocIndex: nc.docIndex,
        newDocFilename: nc.filename,
        newChunkText: nc.text,
        similarity: best.score,
      });
    }
  }
  return conflicts;
}

export interface KnowledgeSearchResult {
  chunkText: string;
  sourceFile?: string;
  /** Phase 73: chunk kind discriminator — lets callers filter / weight by type. */
  kind: KnowledgeChunkKind;
  /** Phase 73: which `knowledge_sources` row produced this chunk. */
  sourceId?: string;
  score: number;
}

export interface SearchKnowledgeOptions {
  topK?: number;
  /** Phase 73: when provided, restrict the candidate pool to chunks of this kind. */
  kind?: KnowledgeChunkKind;
}

export async function searchKnowledge(
  db: Database.Database,
  roleId: string,
  query: string,
  embedFn: (text: string) => Promise<Float32Array>,
  optsOrTopK: SearchKnowledgeOptions | number = {},
): Promise<KnowledgeSearchResult[]> {
  // Backward-compat: previous callers passed `topK` as the 5th positional arg.
  const opts: SearchKnowledgeOptions = typeof optsOrTopK === 'number'
    ? { topK: optsOrTopK }
    : optsOrTopK;
  const topK = opts.topK ?? 5;

  // Phase 73: push the kind filter into the DB query so we don't load the
  // whole chunk table just to discard most of it. cosine ranking happens in
  // JS over whatever survives the WHERE clause.
  const chunks = getChunksForRole(db, roleId, opts.kind ? { kind: opts.kind } : {});
  if (chunks.length === 0) return [];

  const queryVec = await embedFn(query);
  return chunks
    .filter((c) => c.embedding != null)
    .map((c) => {
      const r: KnowledgeSearchResult = {
        chunkText: c.chunkText,
        kind: c.kind,
        score: cosineSimilarity(queryVec, c.embedding!),
      };
      if (c.sourceFile !== undefined) r.sourceFile = c.sourceFile;
      if (c.sourceId !== undefined) r.sourceId = c.sourceId;
      return r;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function chunkDocument(content: string, filename: string): Array<{ text: string }> {
  const CHUNK_SIZE = 800;
  const OVERLAP = 100;
  const lines = content.split('\n');
  const chunks: Array<{ text: string }> = [];
  let buffer: string[] = [];
  let bufLen = 0;

  for (const line of lines) {
    buffer.push(line);
    bufLen += line.length + 1;
    if (bufLen >= CHUNK_SIZE) {
      chunks.push({ text: `[${filename}]\n${buffer.join('\n')}` });
      const overlapLines: string[] = [];
      let overlapLen = 0;
      for (let i = buffer.length - 1; i >= 0 && overlapLen < OVERLAP; i--) {
        overlapLines.unshift(buffer[i]!);
        overlapLen += buffer[i]!.length + 1;
      }
      buffer = overlapLines;
      bufLen = overlapLen;
    }
  }
  if (buffer.length > 0) {
    chunks.push({ text: `[${filename}]\n${buffer.join('\n')}` });
  }
  return chunks;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
