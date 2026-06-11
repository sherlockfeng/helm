/**
 * LocalRolesProvider — surfaces the seeded built-in roles and any
 * user-trained custom roles via the KnowledgeProvider interface.
 *
 * Per PROJECT_BLUEPRINT.md §11.5: this provider needs no `mappings`. Its scope
 * is "the chat in the UI is bound to a role" — but v1 doesn't ship the
 * binding UI yet, so:
 *
 *   - canHandle: always true (cheap, no IO; aggregator decides whether to
 *     consult based on whether sessionStart context is wanted)
 *   - getSessionContext: only fires when an explicit role resolver maps the
 *     hostSessionId to a roleId; otherwise returns null (no surprise injection)
 *   - search: cross-role RAG over all stored knowledge_chunks, ranked by
 *     cosine similarity against the query embedding
 *
 * The role-resolver callback is the seam where Phase 9's UI wires "user
 * picked Product role for this chat" into the provider. Until then, calling
 * code can pass a callback backed by a config map (e.g. cwd → roleId).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  getRole,
  listRoles,
  searchKnowledge,
  type KnowledgeSearchResult,
} from '../roles/library.js';
import { getChunksForRole } from '../storage/repos/roles.js';
import { recordRetrieval } from '../storage/repos/retrieval-log.js';
import type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeProviderHealth,
  KnowledgeSnippet,
} from './types.js';

export type RoleResolver = (ctx: KnowledgeContext) =>
  | string
  | readonly string[]
  | undefined
  | Promise<string | readonly string[] | undefined>;

export interface LocalRolesProviderOptions {
  db: Database.Database;
  embedFn: (text: string) => Promise<Float32Array>;
  /**
   * Phase 42: resolve the role(s) bound to a given session. Return:
   *   - undefined / empty array → no auto-inject (provider returns null)
   *   - a single role id (string) → legacy single-role behavior
   *   - readonly string[] → concatenate every role's prompt + chunks
   *
   * The orchestrator wires this to read the host_session_roles join table.
   */
  resolveRoleId?: RoleResolver;
  /** TopK across all chunks. Default 5. */
  topK?: number;
  /** Per-role cap when injecting session context. Default 3 chunks. */
  sessionContextChunkCap?: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_SESSION_CHUNK_CAP = 3;

export class LocalRolesProvider implements KnowledgeProvider {
  readonly id = 'local-roles';
  readonly displayName = 'Local Roles';

  private readonly db: Database.Database;
  private readonly embedFn: (text: string) => Promise<Float32Array>;
  private readonly resolveRoleId?: RoleResolver;
  private readonly topK: number;
  private readonly sessionContextChunkCap: number;

  constructor(options: LocalRolesProviderOptions) {
    this.db = options.db;
    this.embedFn = options.embedFn;
    this.resolveRoleId = options.resolveRoleId;
    this.topK = options.topK ?? DEFAULT_TOP_K;
    this.sessionContextChunkCap = options.sessionContextChunkCap ?? DEFAULT_SESSION_CHUNK_CAP;
  }

  canHandle(): boolean {
    return true;
  }

  async getSessionContext(ctx: KnowledgeContext): Promise<string | null> {
    if (!this.resolveRoleId) return null;
    const resolved = await this.resolveRoleId(ctx);
    const roleIds = (() => {
      if (!resolved) return [];
      if (typeof resolved === 'string') return [resolved];
      return [...resolved];
    })();
    if (roleIds.length === 0) return null;

    // Phase 42: render each bound role as its own H1 block, separated by a
    // blank line so Cursor sees clean section boundaries. A missing role
    // (id pointed at a row that's been deleted) is silently skipped instead
    // of failing the whole injection — UX trumps strictness here.
    const blocks: string[] = [];
    for (const roleId of roleIds) {
      const role = (() => {
        try { return getRole(this.db, roleId); }
        catch { return undefined; }
      })();
      if (!role) continue;

      const lines: string[] = [`# Role: ${role.name}`, '', role.systemPrompt];
      const chunks = getChunksForRole(this.db, roleId).slice(0, this.sessionContextChunkCap);
      if (chunks.length > 0) {
        lines.push('', '## Knowledge excerpts');
        for (const chunk of chunks) {
          lines.push('', chunk.chunkText);
        }
      }
      blocks.push(lines.join('\n'));
    }
    if (blocks.length === 0) return null;
    return blocks.join('\n\n');
  }

  async search(query: string, ctx?: KnowledgeContext): Promise<KnowledgeSnippet[]> {
    const roles = listRoles(this.db);
    const allResults: Array<KnowledgeSearchResult & { roleId: string; roleName: string }> = [];

    // Search per-role (each role's chunks are tagged with that role's id) and
    // tag results so we can render which role the snippet came from.
    for (const role of roles) {
      const matches = await searchKnowledge(this.db, role.id, query, this.embedFn, this.topK);
      for (const m of matches) {
        allResults.push({ ...m, roleId: role.id, roleName: role.name });
      }
    }

    const fused = allResults
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK);

    // PR 3 (Conversation Detail backend): persist a retrieval_log entry so
    // the Conversation Detail right rail can show "knowledge in play at
    // turn N" and KnowledgePoint Detail can answer "which conversations
    // cited me?". Best-effort: a writer failure must NEVER bubble up — the
    // chat surface is more important than the audit row.
    if (ctx?.hostSessionId) {
      try {
        recordRetrieval(this.db, {
          id: randomUUID(),
          hostSessionId: ctx.hostSessionId,
          turn: ctx.turn ?? 0,
          queryText: query,
          ts: Date.now(),
        }, fused.map((r, i) => ({
          // `chunkId` is the canonical id of the underlying knowledge_chunks
          // row; KnowledgePoint Detail reverse-lookups go through this id.
          pointId: r.chunkId,
          rank: i,
          fusionScore: r.score,
          legContrib: {
            bm25Rank: r.bm25Score != null ? i : undefined,
            entityRank: r.entityScore != null ? i : undefined,
          },
          // Every fused hit returned to the agent counts as "injected"
          // for v1 — the trimming above the topK boundary is what we'd
          // mark `injected:false` for. Future refinements (diversification,
          // de-dup) can flip this individually.
          injected: true,
        })));
      } catch {
        // swallow — fire-and-forget audit
      }
    }

    return fused.map((r) => ({
      source: this.id,
      title: `${r.roleName}${r.sourceFile ? ` — ${r.sourceFile}` : ''}`,
      body: r.chunkText,
      score: r.score,
      citation: `local-roles:${r.roleId}${r.sourceFile ? `:${r.sourceFile}` : ''}`,
    }));
  }

  async healthcheck(): Promise<KnowledgeProviderHealth> {
    try {
      const roles = listRoles(this.db);
      const totalChunks = roles
        .map((r) => getChunksForRole(this.db, r.id).length)
        .reduce((a, b) => a + b, 0);
      if (roles.length === 0) {
        return { ok: false, reason: 'no roles seeded' };
      }
      return { ok: true, reason: `${roles.length} roles, ${totalChunks} chunks` };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
}
