/**
 * Plugin system — Phase 79.
 *
 * helm core defines extension points; specific backends (TOS / S3 / git / …)
 * live as separate npm-style modules under `~/.helm/plugins/<id>/` and are
 * loaded at boot when listed in `config.plugins.enabled`.
 *
 * v1 only exposes ONE extension point: StoragePlugin (remote object
 * read/write for role-bundle subscription). Embedder / LLM extension
 * points are deliberately deferred (Decision P6A).
 *
 * Plugin authors vendor (copy) this file into their plugin repo; helm
 * does NOT publish a `helm-plugin-api` npm package for v1 (Decision P5A).
 *
 * API stability contract:
 *   - `apiVersion` field on every plugin pins the contract version it
 *     was written against.
 *   - helm maintains `SUPPORTED_PLUGIN_API_VERSIONS` (a list); refusing
 *     to load incompatible plugins keeps user data safe.
 *   - Bumping the API version is a deliberate breaking-change event;
 *     existing plugins keep working at their declared version until they
 *     opt in.
 */

/** Bumped on incompatible plugin-API changes. Current: 1. */
export const PLUGIN_API_VERSION_CURRENT = 1 as const;

/** Versions helm core can load. Add older versions here when extending
 *  the API in backward-compatible ways; remove obsolete versions to drop
 *  support. */
export const SUPPORTED_PLUGIN_API_VERSIONS: readonly number[] = [1];

/**
 * Storage plugin — implements ONE URL scheme. helm parses the subscription
 * URL's scheme prefix and dispatches to the matching plugin.
 *
 * Implementations should be PURE w.r.t. helm state: don't read or write
 * the helm DB, the file system outside the URL target, or any helm-
 * specific config beyond what's passed in `init`. helm core is the only
 * thing that knows about roles, candidates, and bundles.
 */
export interface StoragePlugin {
  /** Unique among loaded plugins. Convention: same as the npm-style
   *  package name, e.g. `"helm-storage-tos"`. */
  id: string;

  /** URL scheme this plugin handles. Lowercased, no `://`. Examples:
   *  `"tos"`, `"s3"`, `"git"`. helm rejects loading two plugins for the
   *  same scheme. */
  scheme: string;

  /** Plugin's own semver. Surfaced in the UI; helm itself doesn't
   *  enforce constraints on this. */
  version: string;

  /** Pinned to the helm plugin API version this plugin targets.
   *  helm refuses to load plugins outside `SUPPORTED_PLUGIN_API_VERSIONS`. */
  apiVersion: number;

  /**
   * Boot-time setup. helm calls this after `require`ing the plugin
   * module and before any download/upload/headEtag call.
   *
   * Throw to signal "plugin is unusable" — helm logs the error, marks
   * the plugin as failed, and skips registration. Subscriptions for
   * this scheme will then status='error' on the next sync attempt.
   */
  init(deps: StoragePluginDeps): Promise<void> | void;

  /**
   * GET the object as bytes. URL scheme is guaranteed to match
   * `this.scheme`. Throw on auth failure, network error, malformed
   * URL, or any non-404 problem; throw a `PluginNotFoundError` (or any
   * error with `code === 'NOT_FOUND'`) when the object is missing.
   */
  download(url: string): Promise<Buffer>;

  /**
   * PUT bytes to the URL. Returns the storage backend's etag (or, when
   * the backend has no etag, a content hash). helm uses this to
   * recognize "unchanged" on subsequent HEAD checks.
   */
  upload(url: string, data: Buffer, opts?: { contentType?: string }): Promise<{ etag: string }>;

  /**
   * HEAD the object: return the current etag without downloading.
   * Cheap; called by the subscription cron every interval. Return
   * `null` when the object doesn't exist (helm pauses the
   * subscription with a friendly error).
   */
  headEtag(url: string): Promise<string | null>;

  /**
   * Optional cleanup hook — called on helm shutdown. Plugin authors
   * MUST implement this if their library spawns daemons, holds
   * sockets, or registers listeners that would prevent process exit.
   *
   * The TOS SDK is a known example: its Consul ServiceWatcher must be
   * explicitly destroyed or the Node process hangs at exit.
   */
  shutdown?(): Promise<void> | void;
}

/**
 * Dependencies injected into `init`. Plugin authors should NOT capture
 * helm-internal state; everything they need to be configurable lives
 * here.
 */
export interface StoragePluginDeps {
  /**
   * Plugin's config block from `~/.helm/config.json`:
   *
   *     { "storage": { "tos": { "endpoint": "…", "region": "…" } } }
   *                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   *                            ← this object lands in `config`
   *
   * Schema is plugin-defined; helm passes through verbatim. Plugin
   * author validates and throws from `init` if config is bad.
   *
   * Convention: NEVER store secrets here. Use environment variables
   * (passed via `env`) for AKSK / API keys / passwords.
   */
  config: Record<string, unknown>;

  /**
   * `process.env`. Plugin authors should prefer env over `config` for
   * any secret-shaped value.
   */
  env: NodeJS.ProcessEnv;

  /** Scoped logger; messages get `module: 'plugins.<plugin-id>'` prefix in helm logs. */
  logger: {
    info(msg: string, data?: object): void;
    warn(msg: string, data?: object): void;
    error(msg: string, data?: object): void;
  };
}

/**
 * Conventional error code for "object not found at this URL".
 * Plugins should set `.code` on the thrown Error so helm distinguishes
 * "missing" (subscription paused with clear message) from "broken"
 * (subscription flips to error status).
 */
export class PluginNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(url: string) { super(`object not found at ${url}`); }
}

/**
 * Result of a plugin load attempt. `ok=true` exposes the live instance;
 * `ok=false` carries the reason (used by the Settings UI to show why
 * a configured plugin isn't running).
 */
export type LoadedPlugin =
  | { ok: true; plugin: StoragePlugin; loadedFrom: string }
  | { ok: false; id: string; reason: string };
