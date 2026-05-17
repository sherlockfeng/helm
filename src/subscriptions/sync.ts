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
  markSubscriptionError,
  markSubscriptionSynced,
} from '../storage/repos/role-subscriptions.js';
import type { RoleSubscription } from '../storage/types.js';
import type { PluginRegistry } from '../plugins/index.js';
import { updateRole } from '../roles/library.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';

export type SubscriptionSyncAction =
  | 'noop'        // headEtag matched last_etag → nothing changed remotely
  | 'unchanged'   // GET succeeded but contentHash matched last_content_hash → no apply needed
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
        etag, contentHash: bundle.contentHash, at: now.toISOString(),
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
