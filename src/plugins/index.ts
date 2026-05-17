/**
 * Plugins module barrel — re-exports the public surface.
 *
 * External plugin authors only need to vendor `types.ts` (the contract).
 * helm internals import from this barrel.
 */

export {
  PLUGIN_API_VERSION_CURRENT,
  PluginNotFoundError,
  SUPPORTED_PLUGIN_API_VERSIONS,
  type LoadedPlugin,
  type StoragePlugin,
  type StoragePluginDeps,
} from './types.js';

export { PluginRegistry } from './registry.js';

export {
  loadPlugins,
  type LoadPluginsInput,
  type PluginsConfig,
  type StorageConfigsByScheme,
} from './loader.js';

export { fileStoragePlugin } from './builtins/file-storage.js';
