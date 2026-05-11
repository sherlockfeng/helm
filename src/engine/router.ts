/**
 * EngineRouter — picks the active LLM engine adapter per call (Phase 68).
 *
 * Construction-time contract: pass in (a) an adapter map keyed by EngineId
 * and (b) a `defaultGetter` that returns the current `liveConfig.engine.default`.
 * `current()` re-reads the getter every call, so a Settings save (which
 * mutates `liveConfig`) flows through without restarting helm.
 *
 * The router DOES NOT instantiate adapters itself — the orchestrator builds
 * them with the right helm-MCP-URL / cwd / API keys and hands them in. That
 * keeps this module free of subprocess concerns and trivially testable with
 * fake adapters.
 *
 * When the requested engine has no adapter (e.g. user picked cursor but
 * cursor-agent CLI failed to register), the router throws a structured
 * error with actionable text. UI converts it to "Open Settings, switch
 * engine or install the missing one".
 */

import type { EngineAdapter, EngineId } from './types.js';

export interface EngineRouterDeps {
  /**
   * Adapters keyed by EngineId. Missing entries are allowed — orchestrator
   * might skip building one whose CLI isn't on PATH. Router throws on
   * `current()` when the requested engine is absent.
   */
  adapters: Partial<Record<EngineId, EngineAdapter>>;
  /** Returns the current default — typically `() => liveConfig.engine.default`. */
  defaultGetter: () => EngineId;
}

export class EngineNotAvailableError extends Error {
  constructor(public readonly engineId: EngineId) {
    super(
      `Engine "${engineId}" is selected as default but not currently available. `
      + `Open Settings → Default engine to switch to a ready engine, or install / `
      + `authenticate "${engineId}" (claude: \`claude login\`; cursor: install `
      + `cursor-agent CLI and sign in to Cursor app).`,
    );
    this.name = 'EngineNotAvailableError';
  }
}

export class EngineRouter {
  constructor(private readonly deps: EngineRouterDeps) {}

  /**
   * Resolve the active adapter. Throws `EngineNotAvailableError` if the
   * configured default isn't in the adapter map. Callers should let this
   * propagate to the HTTP layer / MCP tool result so the UI gets the
   * "switch engine" hint.
   */
  current(): EngineAdapter {
    const id = this.deps.defaultGetter();
    const adapter = this.deps.adapters[id];
    if (!adapter) throw new EngineNotAvailableError(id);
    return adapter;
  }

  /** Override for cases where the caller already knows it wants a specific engine. */
  byId(id: EngineId): EngineAdapter {
    const adapter = this.deps.adapters[id];
    if (!adapter) throw new EngineNotAvailableError(id);
    return adapter;
  }

  /** Which engines are wired up right now. Used by Settings health endpoint. */
  available(): EngineId[] {
    return (Object.keys(this.deps.adapters) as EngineId[]).filter(
      (id) => this.deps.adapters[id] !== undefined,
    );
  }
}
