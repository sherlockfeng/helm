/**
 * KnowledgeRepo importer (PR 5.5b).
 *
 * Walks a cloned repo's `roles/<slug>/` directory tree, converts each
 * `.md` file into a ParsedPoint via the chosen profile, and upserts
 * the result into helm's knowledge tables. Idempotent on re-run: a
 * point that already exists with the same id is updated in place, the
 * alias / rel sets are rebuilt to match the file (so removing an
 * alias on disk removes it from the DB on the next import).
 *
 * Layout assumption:
 *
 *   <localPath>/
 *     roles/
 *       <role-slug>/
 *         role.yaml   (optional — frontmatter-style metadata)
 *         points/
 *           <point-id>.md
 *           ...
 *
 * Roles without a role.yaml get a synthesized name from the slug. The
 * importer does NOT delete points / roles that disappeared from disk
 * — that's a separate "prune missing" step a future PR can add once
 * we have UX for it. Local edits on deleted upstream rows shouldn't
 * be silently lost.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { parseMarkdownWithFrontmatter } from './frontmatter.js';
import {
  parsePointFile,
  type KnowledgeRepoProfile,
  type ParsedPoint,
} from './profiles.js';
import {
  insertChunk,
  insertChunkEntity,
  upsertRole,
  getChunkById,
  getRole,
} from '../storage/repos/roles.js';
import { extractEntities } from '../roles/entity-extract.js';
import {
  setAliasesForPoint,
} from '../storage/repos/knowledge-point-alias.js';
import {
  addRel,
  getOutgoingRels,
  removeRel,
} from '../storage/repos/knowledge-point-rel.js';
import {
  attachRoleToPoint,
} from '../storage/repos/knowledge-point-roles.js';

export interface ImporterInput {
  db: Database.Database;
  /** Working directory of the cloned repo. */
  localPath: string;
  profile: KnowledgeRepoProfile;
  /** Mark every imported point with this source ref (e.g. repoId). */
  sourceRef?: string;
  /** Override fs functions for tests. */
  fs?: {
    readdirSync?: typeof readdirSync;
    readFileSync?: typeof readFileSync;
    existsSync?: typeof existsSync;
    statSync?: typeof statSync;
  };
}

export interface ImportSummary {
  rolesImported: number;
  pointsUpserted: number;
  /**
   * PR-4 (files-as-truth): always 0. The merge-conflict flow is retired
   * — files in the working copy ARE the truth, so the import always
   * syncs the DB row to the file. Field kept for API compatibility.
   */
  conflictsDetected: number;
  /** Per-file failures (path → message). The importer continues on each. */
  errors: Record<string, string>;
}

export function importRepoIntoLibrary(input: ImporterInput): ImportSummary {
  const fs = {
    readdirSync: input.fs?.readdirSync ?? readdirSync,
    readFileSync: input.fs?.readFileSync ?? readFileSync,
    existsSync: input.fs?.existsSync ?? existsSync,
    statSync: input.fs?.statSync ?? statSync,
  };
  const summary: ImportSummary = { rolesImported: 0, pointsUpserted: 0, conflictsDetected: 0, errors: {} };

  // R-? (verification fix): the layout the importer walks depends on
  // the profile. The original implementation only knew helm-native's
  // roles/<slug>/points/ layout, which silently no-op'd on llm-wiki
  // (whose real layout is dr-docs/, doc-lsp-docs/, ... at the repo
  // root). Each profile now produces a list of (roleId, roleDir,
  // pointFiles) triples for the import loop to upsert.
  const roleBuckets = enumerateRolesForProfile(fs, input.localPath, input.profile);
  if (roleBuckets.length === 0) return summary;

  // chat-captured/<user>/<role>/ produces one bucket per (user, role)
  // pair — several buckets can legitimately share a roleId. Count
  // unique roles, not buckets.
  const seenRoles = new Set<string>();
  for (const bucket of roleBuckets) {
    const now = new Date().toISOString();
    // Preserve an existing role's prompt + identity: ON CONFLICT in
    // upsertRole overwrites system_prompt, so a bucket without
    // briefing text (llm-wiki dirs never carry one) would wipe a
    // trained prompt on every re-import.
    const existingRole = getRole(input.db, bucket.roleId);
    upsertRole(input.db, {
      id: bucket.roleId,
      name: bucket.roleName,
      systemPrompt: bucket.briefingText
        ?? existingRole?.systemPrompt
        ?? '',
      isBuiltin: existingRole?.isBuiltin ?? false,
      createdAt: existingRole?.createdAt ?? now,
    });
    if (!seenRoles.has(bucket.roleId)) {
      seenRoles.add(bucket.roleId);
      summary.rolesImported += 1;
    }

    for (const file of bucket.pointFiles) {
      const relPath = relative(bucket.roleDir, file).split(sep).join('/');
      // Repo-root-relative path — persisted as the chunk's source_file
      // so publish round-trips into the same file (llmWikiLayout) and
      // the UI can show real provenance.
      const repoRelPath = relative(input.localPath, file).split(sep).join('/');
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = parsePointFile({
          text: raw, relativePath: relPath, profile: input.profile,
        });
        upsertPoint(input.db, bucket.roleId, parsed, {
          sourceRef: input.sourceRef,
          repoRelPath,
        });
        summary.pointsUpserted += 1;
        // R-10: index entities so retrieval picks the chunk up (cheap,
        // deterministic). The embedding write retired with the cosine
        // leg (PR-4).
        enrichChunk(input.db, parsed, bucket.roleId, relPath);
      } catch (err) {
        summary.errors[file] = (err as Error).message;
      }
    }
  }

  return summary;
}

interface RoleBucket {
  roleId: string;
  roleName: string;
  briefingText?: string;
  /** The dir paths under this bucket are walked recursively for .md files. */
  roleDir: string;
  pointFiles: string[];
}

type WalkerFs = NonNullable<ImporterInput['fs']> & {
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  existsSync: typeof existsSync;
  statSync: typeof statSync;
};

/** Per-profile role enumeration. Each profile picks its own layout convention. */
function enumerateRolesForProfile(
  fs: WalkerFs,
  localPath: string,
  profile: KnowledgeRepoProfile,
): RoleBucket[] {
  if (profile === 'helm-native') return enumerateHelmNative(fs, localPath);
  if (profile === 'llm-wiki')    return enumerateLlmWiki(fs, localPath);
  return enumerateGeneric(fs, localPath);
}

/**
 * helm-native layout: roles/<slug>/role.yaml + points/<id>.md.
 * Unchanged from the original importer behaviour — helm-published
 * repos follow this convention.
 */
function enumerateHelmNative(fs: WalkerFs, localPath: string): RoleBucket[] {
  const rolesRoot = join(localPath, 'roles');
  if (!fs.existsSync(rolesRoot)) return [];
  const slugs = fs.readdirSync(rolesRoot)
    .filter((slug) => fs.statSync(join(rolesRoot, slug)).isDirectory());
  const out: RoleBucket[] = [];
  for (const slug of slugs) {
    const roleDir = join(rolesRoot, slug);
    const meta = readRoleMeta(fs, roleDir);
    const pointsDir = join(roleDir, 'points');
    const pointFiles = fs.existsSync(pointsDir)
      ? walkMarkdownFiles(fs, pointsDir) : [];
    out.push({
      roleId: meta.id ?? slug,
      roleName: meta.name ?? slug,
      ...(meta.briefingText ? { briefingText: meta.briefingText } : {}),
      roleDir: pointsDir,
      pointFiles,
    });
  }
  return out;
}

/**
 * llm-wiki layout: each top-level non-hidden directory at the repo
 * root is a role bucket (e.g. dr-docs/, doc-lsp-docs/, benchmark/).
 * .md files anywhere under those dirs are points. The repo doesn't
 * carry role.yaml — we synthesize role names from the dir slug.
 *
 * Skip-list: anything starting with `.`, plus a curated set of dirs
 * that aren't knowledge content (workflow/automation/CI metadata).
 */
/**
 * Files-as-truth: the directory helm owns inside an llm-wiki repo.
 * Layout is chat-captured/<user>/<role>/<slug>.md — the role is the
 * THIRD path segment, not the top-level dir. See
 * memory design_files_as_truth.md for the locked convention.
 */
const CHAT_CAPTURED_DIR = 'chat-captured';

function enumerateLlmWiki(fs: WalkerFs, localPath: string): RoleBucket[] {
  if (!fs.existsSync(localPath)) return [];
  const SKIP_DIRS = new Set([
    'node_modules', '.codebase', '.context', '.cursor',
    '.doc-lsp', '.doc-lsp-references', '.git', '.github', '.skills',
  ]);
  const slugs = fs.readdirSync(localPath)
    .filter((name) => !name.startsWith('.') && !SKIP_DIRS.has(name))
    .filter((name) => {
      try { return fs.statSync(join(localPath, name)).isDirectory(); }
      catch { return false; }
    });
  const out: RoleBucket[] = [];
  for (const slug of slugs) {
    const roleDir = join(localPath, slug);
    if (slug === CHAT_CAPTURED_DIR) {
      // helm's own zone: one bucket per (user, role) pair so a role's
      // captured knowledge merges with the role regardless of author.
      out.push(...enumerateChatCaptured(fs, roleDir));
      continue;
    }
    const pointFiles = walkMarkdownFiles(fs, roleDir);
    if (pointFiles.length === 0) continue; // skip dirs with no .md
    out.push({
      roleId: slug,
      roleName: slug,
      roleDir,
      pointFiles,
    });
  }
  return out;
}

function enumerateChatCaptured(fs: WalkerFs, capturedRoot: string): RoleBucket[] {
  const out: RoleBucket[] = [];
  let users: string[];
  try {
    users = fs.readdirSync(capturedRoot).filter((name) => {
      if (name.startsWith('.')) return false;
      try { return fs.statSync(join(capturedRoot, name)).isDirectory(); }
      catch { return false; }
    });
  } catch {
    return out;
  }
  for (const user of users) {
    const userDir = join(capturedRoot, user);
    let roleDirs: string[];
    try {
      roleDirs = fs.readdirSync(userDir).filter((name) => {
        if (name.startsWith('.')) return false;
        try { return fs.statSync(join(userDir, name)).isDirectory(); }
        catch { return false; }
      });
    } catch {
      continue;
    }
    for (const role of roleDirs) {
      const roleDir = join(userDir, role);
      const pointFiles = walkMarkdownFiles(fs, roleDir);
      if (pointFiles.length === 0) continue;
      out.push({ roleId: role, roleName: role, roleDir, pointFiles });
    }
  }
  return out;
}

/**
 * generic layout: one synthesized role holds every .md the repo
 * exposes (recursive, skipping hidden + standard non-content dirs).
 * Useful for repos that aren't knowledge-shaped at all but the user
 * still wants raw .md ingestion.
 */
function enumerateGeneric(fs: WalkerFs, localPath: string): RoleBucket[] {
  if (!fs.existsSync(localPath)) return [];
  const SKIP_DIRS = new Set(['node_modules', '.git', '.github']);
  // Walk top-level, then recurse through accepted dirs.
  const pointFiles: string[] = [];
  const stack: string[] = [localPath];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try { entries = fs.readdirSync(cur); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const full = join(cur, entry);
      let stat: ReturnType<typeof fs.statSync>;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile() && entry.toLowerCase().endsWith('.md')) {
        pointFiles.push(full);
      }
    }
  }
  if (pointFiles.length === 0) return [];
  return [{
    roleId: 'imported',
    roleName: 'Imported',
    roleDir: localPath,
    pointFiles,
  }];
}

/** R-10: keep imported chunks searchable by indexing entities. */
function enrichChunk(
  db: Database.Database,
  parsed: ParsedPoint,
  roleId: string,
  filename: string,
): void {
  const now = new Date().toISOString();
  // Wipe existing entity rows for this chunk so a re-import that
  // changed the body doesn't carry stale entities. Cheap on the
  // current row count — (chunk_id) is in the PK.
  db.prepare(`DELETE FROM knowledge_chunk_entities WHERE chunk_id = ?`).run(parsed.id);
  const entities = extractEntities(parsed.body, filename);
  for (const e of entities) {
    insertChunkEntity(db, {
      chunkId: parsed.id, roleId, entity: e.entity, createdAt: now,
    });
  }
}

/** Read role.yaml as frontmatter-style key/value pairs. */
function readRoleMeta(
  fs: NonNullable<ImporterInput['fs']> & {
    existsSync: typeof existsSync; readFileSync: typeof readFileSync;
  },
  roleDir: string,
): { id?: string; name?: string; briefingText?: string } {
  const yamlPath = join(roleDir, 'role.yaml');
  if (!fs.existsSync(yamlPath)) return {};
  // Parse `role.yaml` as the frontmatter section of a doc with no body.
  const text = `---\n${fs.readFileSync(yamlPath, 'utf8')}\n---\n`;
  const { data } = parseMarkdownWithFrontmatter(text);
  const out: { id?: string; name?: string; briefingText?: string } = {};
  if (typeof data['id'] === 'string') out.id = data['id'];
  if (typeof data['name'] === 'string') out.name = data['name'];
  // Several plausible keys point at the same thing; accept either.
  const briefing = data['briefingText'] ?? data['briefing'] ?? data['description'];
  if (typeof briefing === 'string') out.briefingText = briefing;
  return out;
}

function walkMarkdownFiles(
  fs: NonNullable<ImporterInput['fs']> & {
    readdirSync: typeof readdirSync; statSync: typeof statSync;
  },
  root: string,
): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = fs.readdirSync(cur);
    for (const entry of entries) {
      const full = join(cur, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile() && entry.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}

function upsertPoint(
  db: Database.Database,
  roleId: string,
  parsed: ParsedPoint,
  opts: {
    sourceRef?: string;
    /** Repo-root-relative path of the .md this point came from.
     *  Persisted to chunk.source_file — files-as-truth provenance +
     *  llmWikiLayout publish round-trip. */
    repoRelPath?: string;
  },
): 'inserted' | 'updated' {
  const now = new Date().toISOString();
  const existing = getChunkById(db, parsed.id);
  if (!existing) {
    // Insert a new chunk. insertChunk already populates the legacy
    // single-role pointer; we ALSO attach via the N..N table so PR 4+
    // readers find the point through the new query path.
    insertChunk(db, {
      id: parsed.id, roleId,
      chunkText: parsed.body, kind: parsed.kind,
      createdAt: now,
      ...(opts.repoRelPath ? { sourceFile: opts.repoRelPath } : {}),
    });
    // R-11: round-trip visibility + source out-of-band from insertChunk
    // (the legacy signature doesn't take them). Same row, single UPDATE.
    applyRoundTripFields(db, parsed);
    attachRoleToPoint(db, parsed.id, roleId);
    syncAuxTables(db, parsed);
    return 'inserted';
  }

  // PR-4 (files-as-truth): the file in the working copy IS the source
  // of truth, so a re-import always syncs the DB row to it — the old
  // edit_version-gated merge-conflict flow is retired. Local DB edits
  // that should survive belong in the file (promote writes them there).
  // We still do NOT bump edit_version: the import is a sync, not a
  // user edit.
  db.prepare(`
    UPDATE knowledge_chunks SET chunk_text = ?, kind = ? WHERE id = ?
  `).run(parsed.body, parsed.kind, parsed.id);
  applySourceFile(db, parsed.id, opts.repoRelPath);
  applyRoundTripFields(db, parsed);
  attachRoleToPoint(db, parsed.id, roleId);
  syncAuxTables(db, parsed);
  return 'updated';
}

/** Persist the repo-root-relative origin path. No-op when absent. */
function applySourceFile(db: Database.Database, pointId: string, repoRelPath?: string): void {
  if (!repoRelPath) return;
  db.prepare(`UPDATE knowledge_chunks SET source_file = ? WHERE id = ?`)
    .run(repoRelPath, pointId);
}

/**
 * R-11: persist visibility + source onto the chunk row after the
 * primary insert / update path. Both fields are nullable; we only
 * write them when the parser surfaced a value, so a `.md` that didn't
 * carry a visibility frontmatter doesn't clobber a row's local value.
 */
function applyRoundTripFields(db: Database.Database, parsed: ParsedPoint): void {
  if (parsed.visibility) {
    db.prepare(`UPDATE knowledge_chunks SET visibility = ? WHERE id = ?`)
      .run(parsed.visibility, parsed.id);
  }
  if (parsed.source) {
    db.prepare(`UPDATE knowledge_chunks SET source = ? WHERE id = ?`)
      .run(JSON.stringify(parsed.source), parsed.id);
  }
}

function syncAuxTables(db: Database.Database, parsed: ParsedPoint): void {

  // Aliases — replace the whole set so a removed entry on disk
  // disappears from the DB on next sync.
  setAliasesForPoint(db, parsed.id,
    parsed.aliases.map((alias) => ({ alias, source: 'imported' as const })),
  );

  // Rel edges — diff existing outgoing edges against the parsed set,
  // remove disappeared ones, add new ones. Cheaper than wiping +
  // re-inserting and keeps created_at meaningful.
  const current = getOutgoingRels(db, parsed.id);
  const want = new Set(parsed.rel.map((r) => `${r.relKind}|${r.toPointId}`));
  for (const r of current) {
    if (!want.has(`${r.relKind}|${r.toPointId}`)) {
      removeRel(db, r.fromPointId, r.toPointId, r.relKind);
    }
  }
  const have = new Set(current.map((r) => `${r.relKind}|${r.toPointId}`));
  for (const r of parsed.rel) {
    if (!have.has(`${r.relKind}|${r.toPointId}`)) {
      addRel(db, parsed.id, r.toPointId, r.relKind);
    }
  }
}
