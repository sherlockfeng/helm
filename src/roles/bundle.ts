/**
 * Role bundle (.helmrole) — Phase 79.
 *
 * `.helmrole` is a self-contained JSON serialization of one role:
 * system prompt + every chunk (with embedding as base64) + every
 * source row + lineage metadata. The format is plain JSON (not a
 * tarball) so it's grep-able, diff-friendly, and one PUT to remote
 * storage uploads the whole thing atomically.
 *
 * Three operations:
 *
 *   - `packRole(db, roleId)` — read role + chunks + sources from helm
 *     DB, produce a RoleBundle Buffer. Used by export endpoint.
 *
 *   - `unpackRole(buffer)` — parse + validate version, decode
 *     embeddings. Throws on bundle-version mismatch or schema error.
 *
 *   - `applyRoleBundle(db, roleId, bundle, opts)` — diff bundle's
 *     chunks against the local role's chunks. NEW chunks → write into
 *     `knowledge_candidates` with `provenance: 'subscription'`.
 *     UNCHANGED chunks → skip (dedup by text_hash). REMOVED chunks
 *     (in local but not in bundle) → ignored in v1 (we don't auto-
 *     delete on remote-side removal; user explicitly drops chunks via
 *     existing UI).
 *
 * contentHash: sha256 of the canonical JSON of just the `chunks`
 * array (sorted by text_hash so insertion order doesn't perturb hash).
 * Subscription sync compares lastContentHash to skip re-applying
 * identical bundles.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getChunksForRole, getRole, listSourcesForRole } from '../storage/repos/roles.js';
import { insertCandidateIfNew } from '../storage/repos/knowledge-candidates.js';
import type {
  KnowledgeCandidate,
  KnowledgeChunkKind,
  KnowledgeSourceKind,
} from '../storage/types.js';

/** Bumped on incompatible bundle-schema changes. */
export const BUNDLE_VERSION_CURRENT = 1 as const;

/** Versions helm core can unpack. */
export const SUPPORTED_BUNDLE_VERSIONS: readonly number[] = [1];

/**
 * Reviewer blocker #3: hard ceiling on unpackRole input size. Bundles
 * are role-scoped knowledge (typically tens of KB, max a few MB). 16MB
 * is comfortably above any legitimate use and below the "this will OOM
 * helm" threshold. A subscription pointing at a 500MB file shouldn't be
 * able to crash the host process during cron catch-up.
 */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

export interface BundleChunk {
  /** Original chunk id at export time. NOT used as PK on import — bundle
   *  consumers may already have a chunk with this id. */
  exportedId?: string;
  chunkText: string;
  kind: KnowledgeChunkKind;
  sourceFile?: string;
  /** Index into bundle.sources of the source row this chunk derives from.
   *  -1 when the chunk had no source (legacy). */
  sourceIndex: number;
  /** sha256 of chunkText — used for dedup at apply time AND for the
   *  bundle's overall contentHash. */
  textHash: string;
  // Reviewer should-fix: embedding field intentionally omitted. The
  // accept path calls updateRole.appendDocuments which re-embeds the
  // chunkText with the local embedder — shipping per-chunk Float32Array
  // bytes (base64) is pure bundle bloat that no consumer reads.
}

export interface BundleSource {
  kind: KnowledgeSourceKind;
  origin: string;
  fingerprint: string;
  label?: string;
}

export interface BundleRole {
  name: string;
  systemPrompt: string;
}

export interface RoleBundle {
  bundleVersion: number;
  exportedAt: string;
  sourceHelmVersion: string;
  /** sha256 over the canonical-form `chunks` array. The same role
   *  exported twice with no changes produces the same hash. */
  contentHash: string;
  role: BundleRole;
  sources: BundleSource[];
  chunks: BundleChunk[];
}

// ── Packing ────────────────────────────────────────────────────────────

export interface PackRoleOptions {
  /** helm's own version stamp; defaults to "unknown" if caller omits. */
  helmVersion?: string;
}

export function packRole(
  db: Database.Database,
  roleId: string,
  opts: PackRoleOptions = {},
): RoleBundle {
  const role = getRole(db, roleId);
  if (!role) throw new Error(`packRole: role not found: ${roleId}`);

  const sourcesRows = listSourcesForRole(db, roleId);
  const sourceIdToIndex = new Map<string, number>();
  const sources: BundleSource[] = sourcesRows.map((s, i) => {
    sourceIdToIndex.set(s.id, i);
    const out: BundleSource = {
      kind: s.kind, origin: s.origin, fingerprint: s.fingerprint,
    };
    if (s.label !== undefined) out.label = s.label;
    return out;
  });

  const chunkRows = getChunksForRole(db, roleId, { includeArchived: true });
  const chunks: BundleChunk[] = chunkRows.map((c) => {
    const textHash = hashText(c.chunkText);
    const out: BundleChunk = {
      exportedId: c.id,
      chunkText: c.chunkText,
      kind: c.kind,
      sourceIndex: c.sourceId !== undefined ? (sourceIdToIndex.get(c.sourceId) ?? -1) : -1,
      textHash,
    };
    if (c.sourceFile !== undefined) out.sourceFile = c.sourceFile;
    // Reviewer should-fix: embedding intentionally not serialized. Accept
    // path re-embeds via updateRole.appendDocuments anyway.
    return out;
  });

  return {
    bundleVersion: BUNDLE_VERSION_CURRENT,
    exportedAt: new Date().toISOString(),
    sourceHelmVersion: opts.helmVersion ?? 'unknown',
    contentHash: computeContentHash(chunks),
    role: { name: role.name, systemPrompt: role.systemPrompt },
    sources,
    chunks,
  };
}

/** Serialize a bundle to its on-wire bytes. */
export function bundleToBytes(bundle: RoleBundle): Buffer {
  // Pretty-print so the file diffs well in tooling. Size cost negligible
  // for v1 (KB-scale bundles).
  return Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
}

// ── Unpacking ─────────────────────────────────────────────────────────

export function unpackRole(buffer: Buffer): RoleBundle {
  // Reviewer blocker #3: size gate BEFORE JSON.parse — a multi-GB
  // payload would OOM Node well inside the parser.
  if (buffer.length > MAX_BUNDLE_BYTES) {
    throw new Error(
      `unpackRole: bundle exceeds MAX_BUNDLE_BYTES (${buffer.length} > ${MAX_BUNDLE_BYTES}). `
      + 'Bundles are role-knowledge serialized — typical size is < 1 MB.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`unpackRole: invalid JSON — ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('unpackRole: bundle root must be an object');
  const b = raw as Record<string, unknown>;
  const version = b['bundleVersion'];
  if (typeof version !== 'number' || !SUPPORTED_BUNDLE_VERSIONS.includes(version)) {
    throw new Error(
      `unpackRole: bundleVersion=${String(version)} unsupported (this helm supports: ${SUPPORTED_BUNDLE_VERSIONS.join(', ')})`,
    );
  }
  if (typeof b['contentHash'] !== 'string') throw new Error('unpackRole: missing contentHash');
  if (typeof b['exportedAt'] !== 'string') throw new Error('unpackRole: missing exportedAt');
  if (typeof b['sourceHelmVersion'] !== 'string') throw new Error('unpackRole: missing sourceHelmVersion');
  if (!b['role'] || typeof b['role'] !== 'object') throw new Error('unpackRole: missing role block');
  if (!Array.isArray(b['sources'])) throw new Error('unpackRole: missing sources array');
  if (!Array.isArray(b['chunks'])) throw new Error('unpackRole: missing chunks array');
  // We trust the shape past these gates; deeper validation lives in
  // applyRoleBundle (which has the role-context to give better errors).
  return raw as RoleBundle;
}

// ── Applying ──────────────────────────────────────────────────────────

export interface ApplyRoleBundleOptions {
  /** Where this bundle came from (for candidate provenance + audit). */
  subscriptionId?: string;
  /** Override clock for testing. */
  now?: Date;
}

export interface ApplyRoleBundleResult {
  /** Bundle chunks that landed as new candidates (provenance='subscription'). */
  candidatesCreated: KnowledgeCandidate[];
  /** Bundle chunks already present locally (dedup'd by textHash). */
  alreadyPresent: number;
  /** Bundle chunks that hit a rejected/pending row → skipped via partial unique. */
  dedupSkipped: number;
}

export function applyRoleBundle(
  db: Database.Database,
  roleId: string,
  bundle: RoleBundle,
  opts: ApplyRoleBundleOptions = {},
): ApplyRoleBundleResult {
  const now = (opts.now ?? new Date()).toISOString();
  const localChunks = getChunksForRole(db, roleId, { includeArchived: true });
  const localHashes = new Set(localChunks.map((c) => hashText(c.chunkText)));

  const candidatesCreated: KnowledgeCandidate[] = [];
  let alreadyPresent = 0;
  let dedupSkipped = 0;

  for (let i = 0; i < bundle.chunks.length; i++) {
    const bc = bundle.chunks[i]!;
    if (localHashes.has(bc.textHash)) {
      alreadyPresent += 1;
      continue;
    }
    const candidate: KnowledgeCandidate = {
      id: randomUUID(),
      roleId,
      chunkText: bc.chunkText,
      sourceSegmentIndex: i,
      kind: bc.kind,
      // Bundle chunks don't carry scorer scores — they're authored content,
      // not statistically discovered. Use 0/0 to make this visible in the
      // UI ("entity=0 cosine=0" tells the user the row came from a
      // subscription, not from chat capture).
      scoreEntity: 0,
      scoreCosine: 0,
      textHash: bc.textHash,
      status: 'pending',
      createdAt: now,
      provenance: 'subscription',
    };
    const inserted = insertCandidateIfNew(db, candidate);
    if (inserted) {
      candidatesCreated.push(candidate);
    } else {
      dedupSkipped += 1;
    }
  }

  return { candidatesCreated, alreadyPresent, dedupSkipped };
}

// ── Helpers ───────────────────────────────────────────────────────────

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Canonical hash over a chunks array: sort by textHash so insertion
 * order doesn't change the result; serialize `kind\ttextHash` per
 * chunk joined by newlines; sha256.
 *
 * Reviewer should-fix: previously this hashed textHash ONLY, so a peer
 * changing only the `kind` (e.g. 'spec' → 'runbook') would produce an
 * identical contentHash and the change would never propagate. Including
 * kind in the canonical form means re-classification triggers a sync
 * the way users expect.
 *
 * Two bundles with the same set of (kind, textHash) pairs (regardless
 * of export order) → same contentHash. This is what the subscription
 * cron checks to decide "is this remote bundle different from what I
 * last applied".
 */
export function computeContentHash(chunks: readonly BundleChunk[]): string {
  const sorted = [...chunks].sort((a, b) => {
    const byHash = a.textHash.localeCompare(b.textHash);
    return byHash !== 0 ? byHash : a.kind.localeCompare(b.kind);
  });
  const canonical = sorted.map((c) => `${c.kind}\t${c.textHash}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
