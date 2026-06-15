/**
 * Verification bootstrap (PR 5b).
 *
 * Resolves the Verification runtime: provider config → HTTP LLM client
 * → bound runner. Returns null when config is absent or invalid so the
 * orchestrator can leave `verificationRunner` undefined and the API
 * layer surfaces 503 instead of crashing.
 *
 * Production wiring lives in `src/app/orchestrator.ts`:
 *   const runner = buildVerificationRunner({ db, ... });
 *   createHelmApp({ ..., verificationRunner: runner ?? undefined });
 *
 * Tests can construct a custom runner directly via `runCase` (PR 5);
 * this module exists for the production path where we read JSON off
 * disk and want a single place to fail-fast on config problems.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { LocalRolesProvider } from '../knowledge/local-roles-provider.js';
import { getChunksForRole } from '../storage/repos/roles.js';
import { getRun } from '../storage/repos/benchmark.js';
import {
  loadProviderConfigFromFile,
  resolveProviders,
  type ProviderConfig,
  type ProviderModel,
  type ResolvedConfig,
  type ResolvedProvider,
} from './provider-config.js';
import { HttpLlmClient } from './http-llm-client.js';
import { makeEngineCompletionClient } from './engine-llm-client.js';
import {
  runCase,
  type CompletionClient,
  type RepoStateProbe,
  type Retriever,
} from './runner.js';
import type { BenchmarkRun } from '../storage/types.js';

export interface BootstrapInput {
  db: Database.Database;
  /** Where to look for providers.json. Defaults to `~/.helm/benchmark/providers.json`. */
  providerConfigPath?: string;
  /** Embedder used by the runtime retriever. Same shape as LocalRolesProvider's. */
  embedFn?: (text: string) => Promise<Float32Array>;
  /** Override for tests — provider config from memory rather than disk. */
  rawConfig?: ProviderConfig;
  /** Override for tests — override env used to resolve apiKey envs. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override for tests — substitute the HTTP client with a fake. When
   * absent we instantiate the real one.
   */
  llmClient?: import('./runner.js').CompletionClient;
  /**
   * Run-now fallback: when there's NO providers.json, build the runner
   * against the app's configured engine (the same `LlmClient` the
   * summarizer uses). Lazy getter so it picks up the current engine.
   */
  engineLlm?: () => import('../summarizer/campaign.js').LlmClient;
  /** Model id passed to the engine client when `engineLlm` is used. */
  engineModel?: string;
}

export type VerificationRunnerFn = (caseId: string) => Promise<BenchmarkRun | null>;

export interface BootstrapResult {
  /** Bound runner, ready to pass into HelmAppDeps.verificationRunner. */
  runner: VerificationRunnerFn;
  /** The resolved providers (kept around so /api/verification can echo). */
  providers: ResolvedConfig;
}

/**
 * Default config path. Exported so the renderer can show the user
 * where Helm expected the file to live.
 */
export function defaultProviderConfigPath(): string {
  const helmHome = process.env['HELM_HOME'] ?? join(homedir(), '.helm');
  return join(helmHome, 'benchmark', 'providers.json');
}

/**
 * Returns null when:
 *   - providers.json does not exist at the given path AND no rawConfig
 *     was provided
 *
 * Throws (and the caller logs + continues with runner=null) when:
 *   - providers.json exists but is malformed
 *   - a referenced apiKeyEnv is empty
 *
 * Production paths SHOULD wrap this in try/catch so a misconfigured
 * machine still boots — verification is opt-in.
 */
/** True when the engine getter resolves without throwing (an engine is
 *  actually configured). The getter throws when no adapter is wired. */
function engineAvailable(getLlm: () => import('../summarizer/campaign.js').LlmClient): boolean {
  try { getLlm(); return true; } catch { return false; }
}

export function buildVerificationRunner(input: BootstrapInput): BootstrapResult | null {
  const path = input.providerConfigPath ?? defaultProviderConfigPath();
  let providers: ResolvedConfig;
  let llm: CompletionClient;

  // Path A (preferred when present): providers.json on disk or rawConfig.
  // This is unchanged — the file path always wins so an explicit
  // benchmark config keeps overriding the app engine.
  const cfg = input.rawConfig ?? (existsSync(path) ? loadProviderConfigFromFile(path) : undefined);
  if (cfg) {
    providers = resolveProviders(cfg, input.env);
    llm = input.llmClient ?? new HttpLlmClient();
  } else if (input.engineLlm && engineAvailable(input.engineLlm)) {
    // Path B (Run-now fallback): no providers.json, but the app has a
    // configured engine. engineAvailable() probes the getter — it throws
    // when no engine is wired (CI/e2e, fresh installs), in which case we
    // fall through to null so /run still reports 503 "no runner" rather
    // than building a runner that 500s at call time. Synthesize a
    // ResolvedConfig whose answer/judge both point at a dummy provider —
    // the engine client ignores it.
    const model = input.engineModel ?? 'auto';
    const dummyModel: ProviderModel = {
      id: model,
      api: 'engine',
      provider: 'engine',
      baseUrl: 'n/a',
      contextWindow: 0,
      maxTokens: 1024,
    };
    const engineProvider: ResolvedProvider = { id: 'engine', model: dummyModel, apiKey: 'n/a' };
    providers = { answer: engineProvider, judge: engineProvider };
    llm = input.llmClient ?? makeEngineCompletionClient(input.engineLlm, model);
  } else {
    // Neither providers.json NOR engineLlm — leave the runner unconfigured.
    return null;
  }

  const embedFn = input.embedFn ?? (async (): Promise<Float32Array> => new Float32Array());
  const localProvider = new LocalRolesProvider({ db: input.db, embedFn });

  // Retriever: ask LocalRolesProvider for snippets via the standard
  // search() path. This benefits from the existing RRF+BM25 fusion +
  // alias / rel-expansion already wired in PR 3. Note that retrieval
  // is scoped by the case's goldenPointIds — we only use search()
  // here for its scoring; the snippet bodies come straight from the
  // chunks repo to keep the snippet text faithful to the row, not the
  // (sometimes trimmed) snippet projection.
  const retrieve: Retriever = async (goldenPointIds) => {
    if (goldenPointIds.length === 0) return [];
    // Use the case's question as a proxy when we don't have an
    // explicit retrieval query; goldens are usually point ids tied
    // to a specific topic so listing them is a fine seed query.
    const seed = goldenPointIds.join(' ');
    await localProvider.search(seed); // primes retrieval_log audit
    // Pull each golden point's body directly so the runner sees the
    // ground-truth text rather than a search-result projection.
    const out = [];
    for (const pointId of goldenPointIds) {
      // Read the chunk row directly — we don't know the role id here,
      // so just SELECT by id.
      const row = input.db.prepare(`SELECT chunk_text FROM knowledge_chunks WHERE id = ?`).get(pointId) as
        { chunk_text?: string } | undefined;
      if (row?.chunk_text) out.push({ pointId, text: row.chunk_text });
    }
    return out;
  };

  // RepoStateProbe — PR 5.5 will fill the real (repoUrl, sha) lookup
  // by walking knowledge_repo + per-point provenance. For now we
  // fingerprint the point body locally so reproduce attempts have a
  // stable sha. isReproducible stays false until the git wiring lands.
  const repoProbe: RepoStateProbe = {
    async probe() { return []; },
    async localFingerprint(pointIds) {
      if (pointIds.length === 0) return null;
      const stmt = input.db.prepare(`SELECT chunk_text, edit_version FROM knowledge_chunks WHERE id = ?`);
      const parts: string[] = [];
      for (const pid of pointIds) {
        const row = stmt.get(pid) as { chunk_text?: string; edit_version?: number } | undefined;
        if (row?.chunk_text) parts.push(`${pid}:${row.edit_version ?? 1}:${row.chunk_text.length}`);
      }
      if (parts.length === 0) return null;
      // crypto hash is in runner.ts; here we just stringify a stable
      // ordering and let the runner's sha256 wrapping take it from there.
      return parts.sort().join('|');
    },
  };

  // Reference roles' chunk lists so the unused warning stays silent —
  // this also keeps a path open for caching the per-role chunk count
  // in a future per-run summary panel.
  void getChunksForRole;

  const runner: VerificationRunnerFn = async (caseId) => {
    const result = await runCase({
      db: input.db, caseId, providers,
      llm, retrieve, repoProbe,
    });
    // runCase persists the run row itself; re-read via getRun so the
    // result is the camelCase BenchmarkRun shape. Returning the raw
    // snake_case row made the renderer read alignmentPct=undefined →
    // toFixed crash on Run now.
    return getRun(input.db, result.runId) ?? null;
  };

  return { runner, providers };
}
