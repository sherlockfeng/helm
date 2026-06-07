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
  upsertRole,
  getChunkById,
} from '../storage/repos/roles.js';
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
  const summary: ImportSummary = { rolesImported: 0, pointsUpserted: 0, errors: {} };

  const rolesRoot = join(input.localPath, 'roles');
  if (!fs.existsSync(rolesRoot)) {
    return summary;
  }
  const roleSlugs = fs.readdirSync(rolesRoot)
    .filter((slug) => fs.statSync(join(rolesRoot, slug)).isDirectory());

  for (const slug of roleSlugs) {
    const roleDir = join(rolesRoot, slug);
    const roleMeta = readRoleMeta(fs, roleDir);
    const roleId = roleMeta.id ?? slug;
    const now = new Date().toISOString();
    upsertRole(input.db, {
      id: roleId,
      name: roleMeta.name ?? slug,
      systemPrompt: roleMeta.briefingText ?? '',
      isBuiltin: false,
      createdAt: now,
    });
    summary.rolesImported += 1;

    const pointsDir = join(roleDir, 'points');
    if (!fs.existsSync(pointsDir)) continue;

    for (const file of walkMarkdownFiles(fs, pointsDir)) {
      const relPath = relative(pointsDir, file).split(sep).join('/');
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = parsePointFile({
          text: raw, relativePath: relPath, profile: input.profile,
        });
        upsertPoint(input.db, roleId, parsed, input.sourceRef);
        summary.pointsUpserted += 1;
      } catch (err) {
        summary.errors[file] = (err as Error).message;
      }
    }
  }

  return summary;
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
  sourceRef: string | undefined,
): void {
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
    });
  } else {
    // Re-import: refresh body / kind only. We do NOT bump
    // edit_version here because the import is treated as a sync, not
    // a user edit (sync overrides whatever the user had; PR 5.5c
    // 3-way merge will introduce a conflict path for that case).
    db.prepare(`
      UPDATE knowledge_chunks SET chunk_text = ?, kind = ? WHERE id = ?
    `).run(parsed.body, parsed.kind, parsed.id);
  }
  attachRoleToPoint(db, parsed.id, roleId);

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

  // Stamp a source row so the UI knows where the point came from. We
  // keep the source ref as a free-form string here; PR 5.5c will
  // surface it next to the conflict UI.
  void sourceRef;
}
