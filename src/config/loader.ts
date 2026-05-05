/**
 * Load + validate `~/.helm/config.json`.
 *
 * On any failure (missing file, malformed JSON, validation error) we return
 * the schema defaults so a botched edit can't block the desktop app from
 * booting. The error is reported through the optional `onError` callback for
 * the Phase 8 logger to record + `helm doctor` to surface.
 */

import { existsSync, readFileSync } from 'node:fs';
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
