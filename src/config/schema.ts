/**
 * Zod schema for `~/.helm/config.json`.
 *
 * Every config field is optional from the user's POV — sensible defaults
 * cover the `helm` zero-config local-only case. Users opt into Lark / Depscope
 * by adding the corresponding sections.
 *
 * Validation runs at boot. On parse failure the loader falls back to defaults
 * so a corrupt config never blocks the app from starting; the diagnostic
 * surfaces via the logger and `helm doctor`.
 */

import { z } from 'zod';

const LarkConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cliCommand: z.string().optional(),
  /** Extra env vars passed to `lark-cli` subprocess. */
  env: z.record(z.string(), z.string()).optional(),
}).strict();

const DepscopeMappingSchema = z.object({
  cwdPrefix: z.string(),
  scmName: z.string(),
}).strict();

const KnowledgeProviderConfigSchema = z.object({
  /** Builtin provider id ('depscope' for now; future 'wiki' / 'sdkdoc'). */
  id: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

/**
 * Phase 77 (knowledge lifecycle): user-tunable thresholds for the background
 * archival sweep and the in-search decay re-rank. All optional with sensible
 * defaults — zero-config users get the same behavior as if the block were
 * absent. Each field can be edited via Settings → Knowledge lifecycle.
 *
 * - `archiveAfterDays` — minimum age (since createdAt) before a chunk is
 *   eligible for archive. Default 90.
 * - `archiveBelowAccessCount` — max access_count for a chunk to still be
 *   considered "cold". 0/1/2 hits in 90+ days → archive. Default 3.
 * - `decayTauDays` — time constant for the `exp(-Δt/τ)` decay applied during
 *   the fusion re-rank. Smaller τ = sharper drop. Default 30.
 * - `decayAlpha` — max boost / penalty the decay multiplier can apply to
 *   the RRF score. `final = rrf * (1 + α * decay)`; α=0.3 caps influence
 *   at ±30%. Default 0.3.
 */
const KnowledgeLifecycleConfigSchema = z.object({
  archiveAfterDays: z.number().int().positive().default(90),
  archiveBelowAccessCount: z.number().int().nonnegative().default(3),
  decayTauDays: z.number().positive().default(30),
  decayAlpha: z.number().min(0).max(1).default(0.3),
}).strict();

const KnowledgeConfigSchema = z.object({
  providers: z.array(KnowledgeProviderConfigSchema).default([]),
  // Phase 77: optional so existing saved configs (without a `lifecycle`
  // key) parse cleanly and the orchestrator's `liveConfig.knowledge?.lifecycle`
  // read keeps the same null-safety. When the field is present, defaults
  // for individual sub-fields are still filled by the inner schema.
  lifecycle: KnowledgeLifecycleConfigSchema.optional(),
  // Files-as-truth PR-2: the <user> path segment promote writes under
  // chat-captured/<user>/<role>/ in the subscribed llm-wiki repo. The
  // directory name lands in company-repo MRs, so it's user-entered
  // (Settings → Knowledge), not derived from git config.
  wikiUsername: z.string().optional(),
}).strict();

const ServerConfigSchema = z.object({
  port: z.number().int().min(0).max(65_535).default(17_317),
}).strict();

const ApprovalConfigSchema = z.object({
  defaultTimeoutMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
  waitPollMs: z.number().int().positive().default(10 * 60 * 1000),
}).strict();

/**
 * Doc-first audit toggle (PROJECT_BLUEPRINT.md §12.3).
 *
 * When `enforce` is true (default), `complete_task` requires a valid
 * `docAuditToken` from a recent `update_doc_first()` call before a dev
 * task can move to completed. Useful for teams running the doc-first
 * workflow; safely disabled for casual / one-off Cursor sessions.
 */
const DocFirstConfigSchema = z.object({
  enforce: z.boolean().default(true),
}).strict();

/**
 * Cursor SDK config for `summarize_campaign` (Phase 24, replaces Phase 22's
 * Anthropic block).
 *
 * - mode 'local' (default): uses the Cursor app's local auth on this machine.
 *   Zero config when the user has Cursor installed + signed in.
 * - mode 'cloud': uses CURSOR_API_KEY env var or the apiKey field. Falls
 *   back to env when apiKey is omitted, so CI / dev shells don't need it in
 *   config.json.
 */
const CursorConfigSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().default('auto'),
  mode: z.enum(['local', 'cloud']).default('local'),
  // R-18: opt-in auto-register helm's MCP server in Cursor's settings.
  // When true, the boot path writes helm's MCP entry into
  // ~/.cursor/mcp.json (or equivalent) so the user can invoke
  // `train_role` etc. from inside Cursor without configuring by hand.
  mcpAutoRegister: z.boolean().default(false),
}).strict();

/**
 * R-18: Claude Code CLI config. helm needs five knobs that Cursor
 * doesn't have because Claude Code is a spawnable CLI rather than a
 * GUI app:
 *
 *   - binaryPath: override when `claude` isn't on PATH
 *   - model: passed to `--model` on CLI invocations
 *   - trainerModel: model used specifically when helm spawns claude
 *     as the trainer subprocess (Roles › "train via chat"). Often
 *     different from the day-to-day default — trainer workloads tend
 *     to want a smarter / slower model.
 *   - mcpAutoRegister: same semantics as Cursor's flag; writes the
 *     helm MCP server into ~/.claude/settings.json on boot.
 *
 * All optional — claude CLI defaults itself when these are omitted.
 */
const ClaudeCodeConfigSchema = z.object({
  binaryPath: z.string().optional(),
  model: z.string().default('auto'),
  trainerModel: z.string().default('auto'),
  mcpAutoRegister: z.boolean().default(false),
}).strict();

/**
 * R-18: Codex CLI config — same shape as Claude Code. Symmetric
 * because Codex is also a spawnable CLI agent that helm can drive
 * as a trainer or as a target for hook installation.
 */
const CodexConfigSchema = z.object({
  binaryPath: z.string().optional(),
  model: z.string().default('auto'),
  trainerModel: z.string().default('auto'),
  mcpAutoRegister: z.boolean().default(false),
}).strict();

// Phase 60b removed AnthropicConfigSchema. The role-trainer chat now
// shells out to `claude` (Claude Code CLI) and uses claude's own auth
// (`claude login`). Helm holds zero LLM API keys for that surface.

// Phase 67: Harness toolchain config. Holds the global "Project Conventions"
// text the reviewer subprocess injects on every review run. MVP only has
// global conventions (no per-project override).
const HarnessConfigSchema = z.object({
  conventions: z.string().default(''),
}).strict();

// Phase 68: global default-engine selector. Picks which LLM engine drives
// the summarizer / Harness reviewer / role-trainer modal. `EngineRouter`
// reads this field at every call site so a Settings save takes effect
// without an orchestrator restart.
//
// Why string-literal union + zod default rather than letting it be optional:
// the rest of helm reads `liveConfig.engine.default` directly, so a missing
// value would force defensive coalescing in every call site. Default to
// 'claude' for backward-compat — that's the engine the existing
// reviewer / role-trainer paths assume.
const EngineConfigSchema = z.object({
  default: z.enum(['cursor', 'claude']).default('claude'),
  // R-18: which CLI agent helm spawns as the trainer subprocess for
  // Roles › "train via chat". Restricted to the spawnable engines
  // (cursor can't serve as a trainer — it's a GUI app). Defaults to
  // 'claude' since that's the original trainer pipeline.
  trainerDefault: z.enum(['claude', 'codex']).default('claude'),
}).strict();

// Phase 79: storage plugin system + role subscription. Two new top-level
// blocks:
//
//   - `plugins.enabled` — allowlist of plugin ids to load from
//     `~/.helm/plugins/<id>/` at boot. Empty by default (no plugins
//     wired). The file:// built-in storage scheme is ALWAYS registered
//     regardless of this list.
//
//   - `storage` — per-scheme config passed to that plugin's `init` as
//     `deps.config`. Shape is opaque to helm (plugin-defined); helm just
//     hands it through. Convention: secrets (AKSK / API keys) go in env
//     vars, NOT here.
//
// We use `z.object({}).passthrough()` for `storage` because the schema
// is plugin-defined; helm should NOT reject unknown keys here.
const PluginsConfigSchema = z.object({
  enabled: z.array(z.string()).default([]),
}).strict();

const StorageConfigSchema = z.record(z.string(), z.record(z.string(), z.unknown())).default({});

export const HelmConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  approval: ApprovalConfigSchema.default({}),
  lark: LarkConfigSchema.default({}),
  knowledge: KnowledgeConfigSchema.default({}),
  docFirst: DocFirstConfigSchema.default({}),
  cursor: CursorConfigSchema.default({}),
  // R-18: per-engine config blocks for the two spawnable CLI agents.
  // Optional in schema (default {}) so an existing config.json that
  // predates these blocks still parses cleanly.
  claudeCode: ClaudeCodeConfigSchema.default({}),
  codex: CodexConfigSchema.default({}),
  harness: HarnessConfigSchema.default({}),
  engine: EngineConfigSchema.default({}),
  // Phase 79
  plugins: PluginsConfigSchema.default({}),
  storage: StorageConfigSchema,
}).strict();

export type HelmConfig = z.infer<typeof HelmConfigSchema>;
export type LarkConfig = z.infer<typeof LarkConfigSchema>;
export type KnowledgeProviderConfig = z.infer<typeof KnowledgeProviderConfigSchema>;
export type DepscopeMapping = z.infer<typeof DepscopeMappingSchema>;
export type KnowledgeLifecycleConfig = z.infer<typeof KnowledgeLifecycleConfigSchema>;

/**
 * Schema slice for the per-provider `config` blob when id === 'depscope'.
 * Re-validated separately so adding new providers doesn't widen the
 * top-level schema.
 */
export const DepscopeProviderConfigSchema = z.object({
  endpoint: z.string().url(),
  authToken: z.string().optional(),
  mappings: z.array(DepscopeMappingSchema).default([]),
  cacheTtlMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
}).strict();

export type DepscopeProviderConfig = z.infer<typeof DepscopeProviderConfigSchema>;

/**
 * Schema slice for the per-provider `config` blob when id === 'tika'.
 * Credentials come from the user's Tika space (tenant id + service
 * account key); the bridge passes them to `npx @tiktok-mcp/tika` as
 * TIKA_ENV / TIKA_SPACE_ID / TIKA_SERVICE_KEY.
 */
export const TikaProviderConfigSchema = z.object({
  tikaEnv: z.string().default('office'),
  spaceId: z.string().min(1),
  serviceKey: z.string().min(1),
  /** Launcher override; default `npx -y @tiktok-mcp/tika`. */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Pin the MCP tool name if the package renames it. */
  toolName: z.string().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
}).strict();

export type TikaProviderConfig = z.infer<typeof TikaProviderConfigSchema>;
