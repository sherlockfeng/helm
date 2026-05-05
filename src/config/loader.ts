/**
 * Load + validate `~/.helm/config.json`.
 *
 * On any failure (missing file, malformed JSON, validation error) we return
 * the schema defaults so a botched edit can't block the desktop app from
 * booting. The error is reported through the optional `onError` callback for
 * the Phase 8 logger to record + `helm doctor` to surface.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from '../constants.js';
import { HelmConfigSchema, type HelmConfig } from './schema.js';

export interface LoadHelmConfigOptions {
  /** Override config path; defaults to PATHS.config. */
  path?: string;
  onError?: (err: Error, ctx: { phase: 'read' | 'parse' | 'validate'; path: string }) => void;
}

export interface LoadHelmConfigResult {
  config: HelmConfig;
  /** True when a real config.json was loaded; false when defaults were used. */
  loaded: boolean;
}

export function loadHelmConfig(options: LoadHelmConfigOptions = {}): LoadHelmConfigResult {
  const path = options.path ?? PATHS.configFile;
  const onError = options.onError ?? (() => {});

  if (!existsSync(path)) {
    return { config: HelmConfigSchema.parse({}), loaded: false };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    onError(err as Error, { phase: 'read', path });
    return { config: HelmConfigSchema.parse({}), loaded: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onError(err as Error, { phase: 'parse', path });
    return { config: HelmConfigSchema.parse({}), loaded: false };
  }

  const result = HelmConfigSchema.safeParse(parsed);
  if (!result.success) {
    onError(new Error(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')),
      { phase: 'validate', path });
    return { config: HelmConfigSchema.parse({}), loaded: false };
  }
  return { config: result.data, loaded: true };
}

export interface SaveHelmConfigOptions {
  path?: string;
}

/**
 * Validate + write a config back to disk. Throws on validation failure so the
 * caller (HTTP API / CLI) can surface a clear error rather than silently
 * persisting a broken config.
 *
 * Atomic write: a sibling `.tmp` file gets renamed into place so a crash
 * mid-write can't leave a half-written file the loader will reject next boot.
 */
export function saveHelmConfig(config: unknown, options: SaveHelmConfigOptions = {}): HelmConfig {
  const path = options.path ?? PATHS.configFile;
  const validated = HelmConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8');
  // rename is atomic on POSIX when src + dst live on the same fs.
  renameSync(tmp, path);
  return validated;
}
