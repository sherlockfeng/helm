/**
 * Subscription sync engine — Phase 79.
 *
 * One pass over all due subscriptions: HEAD via the matched storage
 * plugin → compare etag → if changed, GET + unpack + applyRoleBundle.
 * Errors per subscription are caught and recorded; one bad subscription
 * doesn't block the rest.
 *
 * Cron drive lives in the orchestrator (boot + setInterval); this
 * module just exposes a pure-ish runner that can be invoked either by
 * the cron tick OR by the manual "Sync now" API endpoint.
 */

import type Database from 'better-sqlite3';
import { applyRoleBundle, unpackRole, type RoleBundle } from '../roles/bundle.js';
import {
  listDueForSync,
  listSubscriptions,
  markSubscriptionConflict,
  markSubscriptionError,
  markSubscriptionSynced,
} from '../storage/repos/role-subscriptions.js';
import { getRole as getRoleRow } from '../storage/repos/roles.js';
import type { RoleSubscription } from '../storage/types.js';
import type { PluginRegistry } from '../plugins/index.js';
import { updateRole } from '../roles/library.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';

export type SubscriptionSyncAction =
  | 'noop'        // headEtag matched last_etag → nothing changed remotely
  | 'unchanged'   // GET succeeded but contentHash matched last_content_hash → no apply needed
  | 'local_ahead' // remote unchanged but local moved past last_pulled_version → no apply (PR B push handles inverse)
  | 'conflict'    // both remote AND local moved past last_pulled_version → user must resolve
  | 'applied'     // bundle applied via candidates queue
  | 'auto_applied' // bundle written straight to role chunks (autoApply=true)
  | 'error';      // any failure

export interface SubscriptionSyncOutcome {
  subscriptionId: string;
  roleId: string;
  action: SubscriptionSyncAction;
  candidatesCreated?: number;
  alreadyPresent?: number;
  dedupSkipped?: number;
  error?: string;
}

export interface RunSyncOptions {
  /** When provided, sync ONLY this subscription. The "Sync now" endpoint
   *  uses this; the cron leaves it undefined to mean "all due". */
  subscriptionId?: string;
  /** Inject a clock for tests. */
  now?: Date;
}

export interface RunSyncDeps {
  db: Database.Database;
  registry: PluginRegistry;
  logger?: {
    info(msg: string, ctx?: object): void;
    warn(msg: string, ctx?: object): void;
  };
}

/**
 * Run one sync pass. Returns per-subscription outcomes for logging /
 * test assertions. Caller decides what to emit on the EventBus.
 */
export async function runSubscriptionSync(
  deps: RunSyncDeps,
  opts: RunSyncOptions = {},
): Promise<SubscriptionSyncOutcome[]> {
  const now = opts.now ?? new Date();
  const subs: RoleSubscription[] = opts.subscriptionId
    ? listSubscriptions(deps.db).filter((s) => s.id === opts.subscriptionId)
    : listDueForSync(deps.db, now);

  const outcomes: SubscriptionSyncOutcome[] = [];
  for (const sub of subs) {
    outcomes.push(await syncOne(deps, sub, now));
  }
  return outcomes;
}

async function syncOne(
  deps: RunSyncDeps,
  sub: RoleSubscription,
  now: Date,
): Promise<SubscriptionSyncOutcome> {
  const plugin = deps.registry.getByScheme(sub.sourceType);
  if (!plugin) {
    const err = `no storage plugin loaded for scheme '${sub.sourceType}'`;
    markSubscriptionError(deps.db, sub.id, err, now.toISOString());
    deps.logger?.warn('subscription_sync_no_plugin', {
      data: { subscriptionId: sub.id, scheme: sub.sourceType },
    });
    return { subscriptionId: sub.id, roleId: sub.roleId, action: 'error', error: err };
  }

  try {
    // 1. HEAD — cheap change detection. Skip GET entirely when etag matches.
    const etag = await plugin.headEtag(sub.sourceUrl);
    if (etag === null) {
      const err = `bundle not found at ${sub.sourceUrl}`;
      markSubscriptionError(deps.db, sub.id, err, now.toISOString());
      return { subscriptionId: sub.id, roleId: sub.roleId, action: 'error', error: err };
    }
    if (etag === sub.lastEtag) {
      // No need to even update timestamps — markSubscriptionSynced just bumps
      // last_sync_at + clears errors. Worth doing so "Sync now" feedback
      // shows fresh "Synced 5s ago".
      markSubscriptionSynced(deps.db, sub.id, { at: now.toISOString() });
      return { subscriptionId: sub.id, roleId: sub.roleId, action: 'noop' };
    }

    // 2. GET full bundle.
    const buffer = await plugin.download(sub.sourceUrl);
    let bundle: RoleBundle;
    try {
      bundle = unpackRole(buffer);
    } catch (err) {
      const msg = `bundle parse failed: ${(err as Error).message}`;
      markSubscriptionError(deps.db, sub.id, msg, now.toISOString());
      return { subscriptionId: sub.id, roleId: sub.roleId, action: 'error', error: msg };
    }

    // 3. Defense-in-depth: contentHash guard. Even if the storage etag
    // changed (e.g. byte-identical re-upload bumping last-modified), if
    // the bundle's own contentHash matches what we last applied, there's
    // nothing new — just update the etag pointer and bail.
    if (bundle.contentHash === sub.lastContentHash) {
      markSubscriptionSynced(deps.db, sub.id, {
        etag,
        contentHash: bundle.contentHash,
        at: now.toISOString(),
      });
      return { subscriptionId: sub.id, roleId: sub.roleId, action: 'unchanged' };
    }

    // 3b. Phase 80 (PR C) — version-aware conflict gate.
    //
    // Compare three numbers to decide whether it's safe to apply:
    //   R = bundle.roleVersion       (what remote says it is)
    //   L = roles.version            (local; bumped by PR A on every edit)
    //   P = sub.lastPulledVersion    (what we successfully applied last)
    //
    // Cases:
    //   - First-ever pull (P is undefined): apply blindly. We have no
    //     baseline to compare against; the user knew this was a remote
    //     subscription when they set it up.
    //   - Bundle has no roleVersion (pre-PR-A peer): fall through to
    //     the existing change-detection-by-contentHash path. We can't
    //     do version-aware logic without a version.
    //   - R == P, L == P: nothing changed on either side. (Already
    //     handled by contentHash guard above.)
    //   - R > P, L == P: fast-forward — remote moved, local unchanged
    //     since last sync. Safe to apply.
    //   - R == P (or R < P), L > P: local moved, remote unchanged.
    //     Nothing to pull; PR B's auto-push handles the inverse.
    //     Bump lastSyncAt so cron stops re-evaluating until next change.
    //   - R > P AND L > P: BOTH sides diverged. Refuse to apply;
    //     surface as `status='conflict'` so the user can resolve.
    const localRole = getRoleRow(deps.db, sub.roleId);
    const L = localRole?.version;
    const R = bundle.roleVersion;
    const P = sub.lastPulledVersion;
    if (P !== undefined && R !== undefined && L !== undefined) {
      if (R <= P && L > P) {
        // Local advanced, remote did not. Don't apply; record the sync
        // timestamp so the cron re-evaluates only on the next remote
        // change.
        markSubscriptionSynced(deps.db, sub.id, {
          etag, contentHash: bundle.contentHash, at: now.toISOString(),
        });
        deps.logger?.info('subscription_sync_local_ahead', {
          data: { subscriptionId: sub.id, roleId: sub.roleId, localVersion: L, remoteVersion: R, lastPulled: P },
        });
        return { subscriptionId: sub.id, roleId: sub.roleId, action: 'local_ahead' };
      }
      if (R > P && L > P) {
        // Both sides moved past the last-pulled snapshot. Don't apply —
        // user resolves via /resolve-conflict (use_remote re-fetches
        // and applies; keep_local advances lastPulled to ack remote).
        const msg = `conflict: local at v${L}, remote at v${R}, last pulled v${P}`;
        markSubscriptionConflict(deps.db, sub.id, msg, now.toISOString());
        deps.logger?.warn('subscription_sync_conflict', {
          data: { subscriptionId: sub.id, roleId: sub.roleId, localVersion: L, remoteVersion: R, lastPulled: P },
        });
        return { subscriptionId: sub.id, roleId: sub.roleId, action: 'conflict', error: msg };
      }
      // R > P && L <= P → fast-forward. Drop through to apply.
    }

    // 4. Apply. Two paths driven by sub.autoApply:
    //    - false (default): write per-chunk candidate rows; user reviews
    //      in the Candidates tab and explicitly accepts/rejects.
    //    - true (trusted source): bypass the queue entirely and write
    //      straight into knowledge_chunks via updateRole. We still pass
    //      force=true so Phase 66 conflict-detection doesn't pop a modal
    //      we have no human to answer.
    if (sub.autoApply) {
      // Filter to chunks NOT already in the local role (textHash dedup)
      // so we don't re-write existing content. The applyRoleBundle path
      // does the same gate; we mimic it here to avoid spurious updates.
      const result = applyRoleBundle(deps.db, sub.roleId, bundle, {
        subscriptionId: sub.id, now,
      });
      const candidates = result.candidatesCreated;
      let autoAccepted = 0;
      if (candidates.length > 0) {
        const embedFn = makePseudoEmbedFn();
        const docs = candidates.map((c) => ({
          filename: `subscription-${sub.id}-${c.id}`,
          content: c.chunkText,
          kind: c.kind,
          sourceKind: 'inline' as const,
          origin: `subscription-${sub.id}`,
          sourceLabel: `Auto-applied from ${sub.sourceType}://`,
        }));
        const upd = await updateRole(deps.db, {
          roleId: sub.roleId,
          appendDocuments: docs,
          embedFn,
          force: true,
        });
        if (upd.status === 'applied') {
          autoAccepted = upd.chunksAdded;
          // Flip each just-created candidate to 'accepted' so the UI
          // doesn't show them as pending. Skip on failure (audit row
          // can be cleaned up manually).
          const setStatusStmt = deps.db.prepare(
            `UPDATE knowledge_candidates SET status = 'accepted', decided_at = ? WHERE id = ?`,
          );
          for (const c of candidates) setStatusStmt.run(now.toISOString(), c.id);
        }
      }
      markSubscriptionSynced(deps.db, sub.id, {
        etag, contentHash: bundle.contentHash,
        // PR C: advance lastPulled when the bundle carried a version.
        // Pre-PR-A peers ship no roleVersion — leave the column alone.
        ...(bundle.roleVersion !== undefined ? { pulledVersion: bundle.roleVersion } : {}),
        at: now.toISOString(),
      });
      deps.logger?.info('subscription_sync_auto_applied', {
        data: {
          subscriptionId: sub.id, roleId: sub.roleId,
          autoAccepted, alreadyPresent: result.alreadyPresent,
        },
      });
      return {
        subscriptionId: sub.id, roleId: sub.roleId,
        action: 'auto_applied',
        candidatesCreated: autoAccepted,
        alreadyPresent: result.alreadyPresent,
        dedupSkipped: result.dedupSkipped,
      };
    }

    // Default path: diff vs local, write subscription-provenance candidates.
    const result = applyRoleBundle(deps.db, sub.roleId, bundle, {
      subscriptionId: sub.id, now,
    });
    markSubscriptionSynced(deps.db, sub.id, {
      etag,
      contentHash: bundle.contentHash,
      // PR C: advance lastPulled when the bundle carried a version.
      ...(bundle.roleVersion !== undefined ? { pulledVersion: bundle.roleVersion } : {}),
      at: now.toISOString(),
    });
    deps.logger?.info('subscription_sync_applied', {
      data: {
        subscriptionId: sub.id,
        roleId: sub.roleId,
        candidatesCreated: result.candidatesCreated.length,
        alreadyPresent: result.alreadyPresent,
        dedupSkipped: result.dedupSkipped,
      },
    });
    return {
      subscriptionId: sub.id,
      roleId: sub.roleId,
      action: 'applied',
      candidatesCreated: result.candidatesCreated.length,
      alreadyPresent: result.alreadyPresent,
      dedupSkipped: result.dedupSkipped,
    };
  } catch (err) {
    const msg = (err as Error).message;
    markSubscriptionError(deps.db, sub.id, msg, now.toISOString());
    deps.logger?.warn('subscription_sync_threw', {
      data: { subscriptionId: sub.id, error: msg },
    });
    return { subscriptionId: sub.id, roleId: sub.roleId, action: 'error', error: msg };
  }
}

// ─── Conflict resolution (Phase 80 / PR C) ───────────────────────────────

export type ResolveConflictStrategy = 'use_remote' | 'keep_local';

export interface ResolveConflictOutcome {
  subscriptionId: string;
  strategy: ResolveConflictStrategy;
  ok: boolean;
  /** Bundle version we adopted as the new lastPulled baseline. */
  pulledVersion?: number;
  /** Populated for 'use_remote' — same shape as a normal apply outcome. */
  candidatesCreated?: number;
  error?: string;
}

/**
 * Resolve a subscription's `status='conflict'` by either:
 *   - `use_remote`: re-fetch the latest remote bundle, apply it (writes
 *     candidates / auto-applies just like a normal sync), advance
 *     `last_pulled_version` to the bundle's roleVersion, mark active.
 *   - `keep_local`: re-fetch + parse to learn the current remote
 *     roleVersion, advance `last_pulled_version` to that, mark active.
 *     Local stays as-is; user explicitly ignored the remote update.
 *
 * Both strategies re-fetch so a "Use remote" against a stale conflict
 * picks up the latest remote, not whatever was around when the cron
 * first detected the divergence.
 */
export async function resolveSubscriptionConflict(
  deps: RunSyncDeps,
  subscriptionId: string,
  strategy: ResolveConflictStrategy,
  opts: { now?: Date } = {},
): Promise<ResolveConflictOutcome> {
  const now = opts.now ?? new Date();
  const sub = listSubscriptions(deps.db).find((s) => s.id === subscriptionId);
  if (!sub) {
    return { subscriptionId, strategy, ok: false, error: 'subscription not found' };
  }

  const plugin = deps.registry.getByScheme(sub.sourceType);
  if (!plugin) {
    return {
      subscriptionId, strategy, ok: false,
      error: `no storage plugin loaded for scheme '${sub.sourceType}'`,
    };
  }

  let bundle: RoleBundle;
  let etag: string | null;
  try {
    etag = await plugin.headEtag(sub.sourceUrl);
    if (etag === null) {
      return { subscriptionId, strategy, ok: false, error: `bundle not found at ${sub.sourceUrl}` };
    }
    const buffer = await plugin.download(sub.sourceUrl);
    bundle = unpackRole(buffer);
  } catch (err) {
    return { subscriptionId, strategy, ok: false, error: (err as Error).message };
  }

  if (strategy === 'keep_local') {
    // Adopt the remote version marker without applying. The user is
    // saying "I know remote changed, I don't want it." A future remote
    // bump past this version will re-evaluate the 4-case gate.
    markSubscriptionSynced(deps.db, subscriptionId, {
      etag,
      contentHash: bundle.contentHash,
      ...(bundle.roleVersion !== undefined ? { pulledVersion: bundle.roleVersion } : {}),
      at: now.toISOString(),
    });
    deps.logger?.info('subscription_conflict_keep_local', {
      data: { subscriptionId, roleId: sub.roleId, remoteVersion: bundle.roleVersion ?? null },
    });
    return {
      subscriptionId, strategy, ok: true,
      pulledVersion: bundle.roleVersion ?? undefined,
    };
  }

  // strategy === 'use_remote' — apply the bundle, bump lastPulled.
  // Always goes through the candidates path (even if autoApply=true)
  // — the user is explicitly resolving, and a candidates review is
  // the safer default after a divergence.
  try {
    const result = applyRoleBundle(deps.db, sub.roleId, bundle, {
      subscriptionId: sub.id, now,
    });
    markSubscriptionSynced(deps.db, subscriptionId, {
      etag,
      contentHash: bundle.contentHash,
      ...(bundle.roleVersion !== undefined ? { pulledVersion: bundle.roleVersion } : {}),
      at: now.toISOString(),
    });
    deps.logger?.info('subscription_conflict_use_remote', {
      data: {
        subscriptionId, roleId: sub.roleId,
        remoteVersion: bundle.roleVersion ?? null,
        candidatesCreated: result.candidatesCreated.length,
      },
    });
    return {
      subscriptionId, strategy, ok: true,
      pulledVersion: bundle.roleVersion ?? undefined,
      candidatesCreated: result.candidatesCreated.length,
    };
  } catch (err) {
    return { subscriptionId, strategy, ok: false, error: (err as Error).message };
  }
}
