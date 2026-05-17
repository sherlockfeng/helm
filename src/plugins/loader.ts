/**
 * Plugin loader — Phase 79.
 *
 * Reads `config.plugins.enabled` (an allowlist of plugin ids), `require`s
 * each from `~/.helm/plugins/<id>/`, calls `init`, and registers the
 * result into the PluginRegistry. Failures are caught per-plugin so one
 * broken plugin can't stop helm from booting.
 *
 * Discovery is intentionally NOT auto-scan (Decision P1A):
 *   - npm-style `helm-storage-*` pattern matching → too magic, surprises
 *   - absolute paths → user has to track filesystem layout
 *   - explicit allowlist → user sees exactly what's loaded, can disable
 *     a misbehaving plugin by editing one config line
 *
 * Plugin module shape: the loader expects `require('<plugin>/')` to
 * return an object matching `StoragePlugin` (either via `export default`
 * compiled to CJS, or `module.exports = {...}`). Both forms work.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  PLUGIN_API_VERSION_CURRENT,
  PluginRegistry,
  type StoragePlugin,
  type StoragePluginDeps,
  SUPPORTED_PLUGIN_API_VERSIONS,
} from './index.js';

export interface PluginsConfig {
  /** Plugin ids to load. Each id corresponds to `~/.helm/plugins/<id>/index.js`. */
  enabled?: string[];
}

export interface StorageConfigsByScheme {
  /** Per-plugin-scheme config block — passed to plugin.init as `deps.config`. */
  [scheme: string]: Record<string, unknown> | undefined;
}

export interface LoadPluginsInput {
  plugins: PluginsConfig;
  storage: StorageConfigsByScheme;
  logger: {
    info(msg: string, data?: object): void;
    warn(msg: string, data?: object): void;
    error(msg: string, data?: object): void;
  };
  /** Override the plugins directory; defaults to `~/.helm/plugins/`. Tests use this. */
  pluginsDir?: string;
  /** Test-only require override (defaults to a fresh createRequire(import.meta.url)). */
  requireOverride?: (modulePath: string) => unknown;
}

/**
 * Load every enabled plugin into the supplied registry. Returns the
 * registry for fluent use. Caller pre-creates the registry so it can
 * be wired into other subsystems (the HTTP API) synchronously, then
 * `await loadPlugins(...)` from `start()` populates it without
 * blocking the synchronous `createHelmApp` factory.
 */
export async function loadPlugins(
  registry: PluginRegistry,
  input: LoadPluginsInput,
): Promise<PluginRegistry> {
  const enabled = input.plugins.enabled ?? [];
  const dir = input.pluginsDir ?? join(homedir(), '.helm', 'plugins');
  // Bind a require() relative to a known file inside the helm package so
  // resolution can find the plugin's node_modules.
  const req = input.requireOverride ?? createRequire(join(dir, '_loader.js'));

  for (const id of enabled) {
    // Reviewer should-fix: id comes from user config and gets join()'d
    // straight into a require() target. Reject path-traversal shapes
    // before they resolve outside `~/.helm/plugins/`. The user can't
    // privilege-escalate against themselves, but a typo like
    // `../../etc/something` silently loading a random module is a
    // footgun worth blocking.
    if (id.includes('/') || id.includes('\\') || id === '.' || id === '..' || id.startsWith('.')) {
      const reason = `invalid plugin id '${id}' (must not contain path separators or leading dots)`;
      input.logger.warn('plugin_id_invalid', { data: { id } });
      registry.registerFailure(id, reason);
      continue;
    }
    const pluginPath = join(dir, id);
    // The existsSync gate is real in production but a hindrance under
    // test (the test supplies a stub require + an arbitrary dir). Skip
    // it when a requireOverride is in play.
    if (!input.requireOverride && !existsSync(pluginPath)) {
      const reason = `plugin directory not found: ${pluginPath}`;
      input.logger.warn('plugin_dir_missing', { data: { id, path: pluginPath } });
      registry.registerFailure(id, reason);
      continue;
    }

    let mod: unknown;
    try {
      mod = req(pluginPath);
    } catch (err) {
      const reason = `require failed: ${(err as Error).message}`;
      input.logger.warn('plugin_require_failed', { data: { id, error: (err as Error).message } });
      registry.registerFailure(id, reason);
      continue;
    }

    // Both `module.exports = {...}` and `export default {...}` (compiled
    // to CJS) end up with the plugin object accessible as either the
    // module itself OR its `.default`.
    const plugin = normalizePluginExport(mod);
    if (!plugin) {
      const reason = 'plugin module did not export a valid StoragePlugin object';
      input.logger.warn('plugin_export_invalid', { data: { id } });
      registry.registerFailure(id, reason);
      continue;
    }

    if (!SUPPORTED_PLUGIN_API_VERSIONS.includes(plugin.apiVersion)) {
      const reason = `plugin apiVersion=${plugin.apiVersion} is unsupported (current helm supports: ${SUPPORTED_PLUGIN_API_VERSIONS.join(', ')})`;
      input.logger.warn('plugin_apiversion_unsupported', {
        data: { id, declared: plugin.apiVersion, current: PLUGIN_API_VERSION_CURRENT },
      });
      registry.registerFailure(id, reason);
      continue;
    }

    if (plugin.id !== id) {
      const reason = `plugin self-id '${plugin.id}' does not match directory name '${id}'`;
      input.logger.warn('plugin_id_mismatch', { data: { dirName: id, selfId: plugin.id } });
      registry.registerFailure(id, reason);
      continue;
    }

    const deps: StoragePluginDeps = {
      config: input.storage[plugin.scheme] ?? {},
      env: process.env,
      logger: {
        info: (msg, data) => input.logger.info(`plugin.${plugin.id}.${msg}`, { data }),
        warn: (msg, data) => input.logger.warn(`plugin.${plugin.id}.${msg}`, { data }),
        error: (msg, data) => input.logger.error(`plugin.${plugin.id}.${msg}`, { data }),
      },
    };

    try {
      await plugin.init(deps);
    } catch (err) {
      const reason = `init threw: ${(err as Error).message}`;
      input.logger.warn('plugin_init_failed', { data: { id, error: (err as Error).message } });
      registry.registerFailure(id, reason);
      continue;
    }

    try {
      registry.registerOk(plugin, pluginPath);
      input.logger.info('plugin_loaded', {
        data: { id, scheme: plugin.scheme, version: plugin.version, apiVersion: plugin.apiVersion },
      });
    } catch (err) {
      // Scheme collision — registerOk threw. Fall back to failure record
      // so the UI shows why the second plugin didn't load.
      const reason = (err as Error).message;
      registry.registerFailure(id, reason);
      input.logger.warn('plugin_scheme_conflict', { data: { id, error: reason } });
    }
  }

  return registry;
}

function normalizePluginExport(mod: unknown): StoragePlugin | null {
  if (!mod || typeof mod !== 'object') return null;
  const candidate = ((mod as { default?: unknown }).default ?? mod) as Record<string, unknown>;
  if (!candidate
    || typeof candidate.id !== 'string'
    || typeof candidate.scheme !== 'string'
    || typeof candidate.version !== 'string'
    || typeof candidate.apiVersion !== 'number'
    || typeof candidate.init !== 'function'
    || typeof candidate.download !== 'function'
    || typeof candidate.upload !== 'function'
    || typeof candidate.headEtag !== 'function'
  ) return null;
  return candidate as unknown as StoragePlugin;
}
