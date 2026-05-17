/**
 * Plugin registry — Phase 79.
 *
 * Thin map from URL scheme → live StoragePlugin. The loader (loader.ts)
 * populates this at boot; subscription sync / API endpoints / the
 * Settings UI all consult it as the single source of truth for
 * "what plugins does this helm install have?".
 *
 * Two slots per "plugin id" — the live instance (when registration
 * succeeded) and a failure record (when it didn't). Surfacing both
 * lets the UI render "helm-storage-tos: failed — init threw: missing
 * TOS_ACCESS_KEY" instead of just silently omitting the broken plugin.
 */

import type { LoadedPlugin, StoragePlugin } from './types.js';

export class PluginRegistry {
  /** scheme → live plugin (only the OK ones). */
  private readonly byScheme = new Map<string, StoragePlugin>();
  /** id → load result (OK or failed). Drives the Settings UI. */
  private readonly byId = new Map<string, LoadedPlugin>();

  /** Insert a successfully-loaded plugin. Throws on scheme collision. */
  registerOk(plugin: StoragePlugin, loadedFrom: string): void {
    if (this.byScheme.has(plugin.scheme)) {
      const existing = this.byScheme.get(plugin.scheme)!;
      throw new Error(
        `plugin scheme conflict: '${plugin.scheme}' is already registered by '${existing.id}'; '${plugin.id}' tried to take it`,
      );
    }
    this.byScheme.set(plugin.scheme, plugin);
    this.byId.set(plugin.id, { ok: true, plugin, loadedFrom });
  }

  /** Record a load failure for UI visibility. Idempotent. */
  registerFailure(id: string, reason: string): void {
    this.byId.set(id, { ok: false, id, reason });
  }

  /** Look up a live plugin by URL scheme; undefined if none registered. */
  getByScheme(scheme: string): StoragePlugin | undefined {
    return this.byScheme.get(scheme);
  }

  /** Full list (OK + failed) for the Settings page. */
  listAll(): LoadedPlugin[] {
    return [...this.byId.values()];
  }

  /** Only OK plugins — used by code that needs to actually dispatch. */
  listLive(): StoragePlugin[] {
    return [...this.byScheme.values()];
  }

  /** Shutdown every live plugin. Errors per plugin are swallowed (warn)
   *  so one broken shutdown doesn't block helm's exit. */
  async shutdownAll(onError?: (id: string, err: Error) => void): Promise<void> {
    const tasks = this.listLive().map(async (p) => {
      try {
        if (p.shutdown) await p.shutdown();
      } catch (err) {
        onError?.(p.id, err as Error);
      }
    });
    await Promise.all(tasks);
    this.byScheme.clear();
    this.byId.clear();
  }
}
