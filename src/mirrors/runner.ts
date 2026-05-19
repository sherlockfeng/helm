/**
 * MirrorRunner — auto-push role bundles to remote (Phase 80 / PR B).
 *
 * Lifecycle in the orchestrator:
 *   const runner = createMirrorRunner({ db, pluginRegistry, helmVersion, logger });
 *   runner.start();
 *   ...
 *   runner.stop();
 *
 * Two pathways into a push:
 *
 *   1. Event-driven (low latency): mutation paths fire
 *      `fireMirrorSync(roleId)` (see ./trigger.ts). `triggerSync` schedules
 *      a debounced timer; the timer fires `pushRole(roleId)` once. If
 *      multiple mutations arrive within the debounce window, the timer
 *      resets — they coalesce into one push (avoids hammering TOS during
 *      a burst of edits).
 *
 *   2. Catch-up sweep (safety net): every `catchUpIntervalMs` the runner
 *      reads `listDueForPush()` and pushes any mirror where the role's
 *      version has advanced past the last-pushed version. This rescues:
 *      - a debounce timer that didn't fire (process restart)
 *      - a transient plugin/network failure (last_error set; sweep
 *        skips it but a manual "Push now" / user edit clears the error)
 *      - mirrors created after the last edit (first-time push)
 *
 * `pushRole` is serial per-role: an in-flight Promise<void> is stashed
 * in a Map keyed by roleId; concurrent triggers await the same promise.
 * This is the same shape used by the subscription sync runner.
 */

import type Database from 'better-sqlite3';
import {
  clearMirrorError,
  getMirror,
  listDueForPush,
  recordPushFailure,
  recordPushSuccess,
} from '../storage/repos/role-mirrors.js';
import { getRole as getRoleRow } from '../storage/repos/roles.js';
import { bundleToBytes, packRole, resolveBundleUploadUrl } from '../roles/bundle.js';
import { setMirrorSyncTrigger } from './trigger.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { Logger } from '../logger/index.js';

export interface MirrorRunnerOptions {
  db: Database.Database;
  pluginRegistry: PluginRegistry;
  /** Stamped onto the bundle's `sourceHelmVersion` (helm's package.json). */
  helmVersion: string;
  /** How long to coalesce trigger calls before pushing. Default 10s. */
  debounceMs?: number;
  /** How often the catch-up sweep runs. Default 60s. */
  catchUpIntervalMs?: number;
  /** Module logger (mirrors); when omitted, runner is silent. */
  logger?: Logger;
  /** Clock injection point for tests. Default `Date.now`. */
  now?: () => number;
  /** Timer factory — defaults to `setTimeout` / `setInterval`. Tests pass
   *  vi.useFakeTimers helpers, but the default is the global. */
  setTimeoutFn?: typeof setTimeout;
  setIntervalFn?: typeof setInterval;
  clearTimeoutFn?: typeof clearTimeout;
  clearIntervalFn?: typeof clearInterval;
}

export interface PushResult {
  ok: boolean;
  pushedVersion?: number;
  etag?: string;
  error?: string;
}

export interface MirrorRunner {
  start(): void;
  stop(): void;
  /** Schedule a debounced push for the given role. Idempotent within the
   *  debounce window — multiple calls coalesce into a single push. */
  triggerSync(roleId: string): void;
  /** Run a push right now, bypassing the debounce. Used by the
   *  catch-up sweep and the manual "Push now" API endpoint. */
  pushRole(roleId: string): Promise<PushResult>;
  /** Run one catch-up sweep cycle immediately. Used in tests + by the
   *  catch-up interval. */
  runCatchUpSweep(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 10_000;
const DEFAULT_CATCH_UP_INTERVAL_MS = 60_000;

export function createMirrorRunner(opts: MirrorRunnerOptions): MirrorRunner {
  const {
    db, pluginRegistry, helmVersion,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    catchUpIntervalMs = DEFAULT_CATCH_UP_INTERVAL_MS,
    logger,
    setTimeoutFn = setTimeout,
    setIntervalFn = setInterval,
    clearTimeoutFn = clearTimeout,
    clearIntervalFn = clearInterval,
  } = opts;

  // Per-role debounce timers. Map.has(roleId) iff a push is queued.
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-role in-flight push promise. Ensures pushRole is serial per role
  // (concurrent triggers + sweep don't double-push the same role).
  const inFlight = new Map<string, Promise<PushResult>>();

  let catchUpInterval: ReturnType<typeof setInterval> | null = null;
  let started = false;

  /**
   * Pack + upload the role bundle, then write the success/failure row.
   * Captures roles.version AT THE TIME OF READ (inside packRole's
   * getRole call). If another mutation lands during the upload, the
   * next debounce/sweep tick will push the newer version — no special
   * handling needed.
   */
  async function pushOnce(roleId: string): Promise<PushResult> {
    const mirror = getMirror(db, roleId);
    if (!mirror) {
      // The user deleted the mirror between trigger and execution.
      // Nothing to do; not an error.
      return { ok: true };
    }
    if (!mirror.enabled) {
      return { ok: true };
    }

    const role = getRoleRow(db, roleId);
    if (!role) {
      // Role deleted out from under us. Mirror row cascades on DELETE
      // ROLE, but in case the cascade hasn't fired yet, bail cleanly.
      return { ok: true };
    }

    let resolvedUrl: string;
    try {
      resolvedUrl = resolveBundleUploadUrl(mirror.targetUrl, roleId);
    } catch (err) {
      const msg = (err as Error).message;
      recordPushFailure(db, { roleId, error: `bad target_url: ${msg}` });
      logger?.warn('mirror_push_failed', { data: { roleId, reason: 'bad_url', error: msg } });
      return { ok: false, error: msg };
    }

    const schemeMatch = resolvedUrl.match(/^([a-z][a-z0-9+.-]*):\/\//);
    if (!schemeMatch) {
      const msg = `target_url has no scheme: ${resolvedUrl}`;
      recordPushFailure(db, { roleId, error: msg });
      logger?.warn('mirror_push_failed', { data: { roleId, reason: 'no_scheme' } });
      return { ok: false, error: msg };
    }

    const plugin = pluginRegistry.getByScheme(schemeMatch[1]!);
    if (!plugin) {
      const msg = `no storage plugin loaded for scheme '${schemeMatch[1]!}'`;
      recordPushFailure(db, { roleId, error: msg });
      logger?.warn('mirror_push_failed', { data: { roleId, reason: 'no_plugin', scheme: schemeMatch[1]! } });
      return { ok: false, error: msg };
    }

    // Snapshot version BEFORE pack — what we record on success.
    const pushedVersion = role.version;
    try {
      const bundle = packRole(db, roleId, { helmVersion });
      const bytes = bundleToBytes(bundle);
      const { etag } = await plugin.upload(resolvedUrl, bytes, { contentType: 'application/json' });
      recordPushSuccess(db, { roleId, pushedVersion, etag });
      logger?.info('mirror_push_ok', {
        data: { roleId, pushedVersion, resolvedUrl, etag, bytes: bytes.length },
      });
      return { ok: true, pushedVersion, etag };
    } catch (err) {
      const msg = (err as Error).message;
      recordPushFailure(db, { roleId, error: msg });
      logger?.warn('mirror_push_failed', { data: { roleId, reason: 'upload_threw', error: msg } });
      return { ok: false, error: msg };
    }
  }

  function pushRole(roleId: string): Promise<PushResult> {
    const existing = inFlight.get(roleId);
    if (existing) return existing;
    const p = (async () => {
      try {
        return await pushOnce(roleId);
      } finally {
        inFlight.delete(roleId);
      }
    })();
    inFlight.set(roleId, p);
    return p;
  }

  function triggerSync(roleId: string): void {
    if (!started) return;
    const existing = debounceTimers.get(roleId);
    if (existing) clearTimeoutFn(existing);
    const t = setTimeoutFn(() => {
      debounceTimers.delete(roleId);
      void pushRole(roleId);
    }, debounceMs);
    // Don't keep the process alive just because a debounce is pending.
    (t as { unref?: () => void }).unref?.();
    debounceTimers.set(roleId, t);
  }

  async function runCatchUpSweep(): Promise<void> {
    if (!started) return;
    let due: ReturnType<typeof listDueForPush>;
    try {
      due = listDueForPush(db);
    } catch (err) {
      logger?.warn('mirror_sweep_query_failed', { data: { error: (err as Error).message } });
      return;
    }
    if (due.length === 0) return;
    logger?.debug('mirror_sweep_tick', { data: { dueCount: due.length } });
    // Push in parallel — plugins are responsible for their own
    // concurrency / rate-limiting (TOS SDK has its own pool).
    await Promise.all(due.map((m) => pushRole(m.roleId)));
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      setMirrorSyncTrigger((roleId) => triggerSync(roleId));
      catchUpInterval = setIntervalFn(() => { void runCatchUpSweep(); }, catchUpIntervalMs);
      (catchUpInterval as { unref?: () => void }).unref?.();
      logger?.info('mirror_runner_started', {
        data: { debounceMs, catchUpIntervalMs },
      });
    },
    stop(): void {
      if (!started) return;
      started = false;
      // Unhook the trigger first so a mutation racing with shutdown
      // doesn't try to schedule new work onto a tearing-down runner.
      setMirrorSyncTrigger(null);
      for (const t of debounceTimers.values()) clearTimeoutFn(t);
      debounceTimers.clear();
      if (catchUpInterval) {
        clearIntervalFn(catchUpInterval);
        catchUpInterval = null;
      }
      // Note: we don't await in-flight pushes. The orchestrator's
      // shutdown order tears down plugins after this; an in-flight
      // upload will reject when its socket closes. The last_error
      // row gets written on the way out; next boot's catch-up will
      // retry once user clears the error.
      logger?.info('mirror_runner_stopped');
    },
    triggerSync,
    pushRole(roleId: string): Promise<PushResult> {
      // Manual "Push now" — clear any pending error so the retry
      // doesn't get filtered out by listDueForPush. Bypasses debounce.
      clearMirrorError(db, roleId);
      const existing = debounceTimers.get(roleId);
      if (existing) {
        clearTimeoutFn(existing);
        debounceTimers.delete(roleId);
      }
      return pushRole(roleId);
    },
    runCatchUpSweep,
  };
}
