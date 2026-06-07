/**
 * Verification provider configuration (PR 5).
 *
 * Schema is intentionally aligned with llm-wiki's `benchmark/provider.json`
 * so users with an existing llm-wiki setup can copy the file across.
 *
 * Two providers per case run: one for **answer** generation (Phase 1) and
 * one for **judge** verdict (Phase 2). They can be the same or different.
 *
 * The file lives at `~/.helm/benchmark/providers.json` by default and is
 * read at runtime. API keys are read via `apiKeyEnv` (preferred) or
 * inline `apiKey` (legacy; not recommended). The loader never logs the
 * resolved key — R-4 redaction applies even at boot.
 */

import { readFileSync } from 'node:fs';

export interface ProviderModel {
  id: string;
  name?: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning?: boolean;
  input?: ReadonlyArray<'text' | 'image'>;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface ProviderEntry {
  model: ProviderModel;
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface ProviderConfig {
  providers: Record<string, ProviderEntry>;
  defaultProvider?: string;
  answerProvider?: string;
  judgeProvider?: string;
}

export interface ResolvedProvider {
  id: string;
  model: ProviderModel;
  apiKey: string;
}

export interface ResolvedConfig {
  answer: ResolvedProvider;
  judge: ResolvedProvider;
}

export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

/**
 * Parse + validate the raw config object. Returns the typed shape or
 * throws `ProviderConfigError` with a precise reason. Does NOT resolve
 * API keys yet — that's `resolveProviders` so tests can verify schema
 * without env vars.
 */
export function validateConfig(raw: unknown): ProviderConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProviderConfigError('config root must be an object');
  }
  const root = raw as Record<string, unknown>;
  if (typeof root['providers'] !== 'object' || root['providers'] === null) {
    throw new ProviderConfigError('"providers" must be an object');
  }
  const providers: Record<string, ProviderEntry> = {};
  for (const [id, entry] of Object.entries(root['providers'] as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new ProviderConfigError(`provider id "${id}" has invalid characters; use [a-zA-Z0-9_-]`);
    }
    if (typeof entry !== 'object' || entry === null) {
      throw new ProviderConfigError(`providers.${id} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['model'] !== 'object' || e['model'] === null) {
      throw new ProviderConfigError(`providers.${id}.model must be an object`);
    }
    const m = e['model'] as Record<string, unknown>;
    const requiredStrings = ['id', 'api', 'provider', 'baseUrl'] as const;
    for (const k of requiredStrings) {
      if (typeof m[k] !== 'string' || (m[k] as string).length === 0) {
        throw new ProviderConfigError(`providers.${id}.model.${k} must be a non-empty string`);
      }
    }
    if (typeof m['contextWindow'] !== 'number' || typeof m['maxTokens'] !== 'number') {
      throw new ProviderConfigError(`providers.${id}.model.contextWindow + maxTokens must be numbers`);
    }
    const hasKey = typeof e['apiKey'] === 'string';
    const hasEnv = typeof e['apiKeyEnv'] === 'string';
    if (!hasKey && !hasEnv) {
      throw new ProviderConfigError(`providers.${id} must set either apiKey or apiKeyEnv`);
    }
    if (hasKey && hasEnv) {
      throw new ProviderConfigError(`providers.${id}: set exactly one of apiKey / apiKeyEnv, not both`);
    }
    providers[id] = e as unknown as ProviderEntry;
  }
  const cfg: ProviderConfig = { providers };
  if (typeof root['defaultProvider'] === 'string') cfg.defaultProvider = root['defaultProvider'];
  if (typeof root['answerProvider']  === 'string') cfg.answerProvider  = root['answerProvider'];
  if (typeof root['judgeProvider']   === 'string') cfg.judgeProvider   = root['judgeProvider'];
  // Resolution: need either defaultProvider alone, OR both answer + judge.
  const haveBoth = cfg.answerProvider && cfg.judgeProvider;
  const haveDefault = cfg.defaultProvider;
  if (!haveBoth && !haveDefault) {
    throw new ProviderConfigError(
      'config must specify either defaultProvider, or both answerProvider and judgeProvider',
    );
  }
  // Each named provider must exist in `providers`.
  for (const name of [cfg.defaultProvider, cfg.answerProvider, cfg.judgeProvider]) {
    if (name && !cfg.providers[name]) {
      throw new ProviderConfigError(`unknown provider "${name}"; not present in providers map`);
    }
  }
  return cfg;
}

/**
 * Resolve `defaultProvider` / `answerProvider` / `judgeProvider` against
 * the providers map and read API keys from env (or inline). Returns the
 * pair the runner will use.
 *
 * `env` is injected so tests can supply a fake `process.env` without
 * mutating the real one.
 */
export function resolveProviders(
  cfg: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const answerId = cfg.answerProvider ?? cfg.defaultProvider;
  const judgeId  = cfg.judgeProvider  ?? cfg.defaultProvider;
  if (!answerId || !judgeId) {
    throw new ProviderConfigError('answer / judge provider not resolvable from config');
  }
  return {
    answer: hydrate(answerId, cfg.providers[answerId]!, env),
    judge:  hydrate(judgeId,  cfg.providers[judgeId]!,  env),
  };
}

function hydrate(id: string, entry: ProviderEntry, env: NodeJS.ProcessEnv): ResolvedProvider {
  let apiKey: string | undefined;
  if (entry.apiKey) apiKey = entry.apiKey;
  else if (entry.apiKeyEnv) apiKey = env[entry.apiKeyEnv];
  if (!apiKey) {
    throw new ProviderConfigError(
      entry.apiKeyEnv
        ? `provider "${id}": env var "${entry.apiKeyEnv}" is empty`
        : `provider "${id}": no API key resolved`,
    );
  }
  return { id, model: entry.model, apiKey };
}

/**
 * Read + validate the on-disk config file. Used in production paths.
 * Throws ProviderConfigError on any failure — the runner catches and
 * surfaces this as a 503 to the renderer.
 */
export function loadProviderConfigFromFile(path: string): ProviderConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ProviderConfigError(
      `cannot read provider config at ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProviderConfigError(
      `provider config ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return validateConfig(parsed);
}
