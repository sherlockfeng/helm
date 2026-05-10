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

const KnowledgeConfigSchema = z.object({
  providers: z.array(KnowledgeProviderConfigSchema).default([]),
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

export const HelmConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  approval: ApprovalConfigSchema.default({}),
  lark: LarkConfigSchema.default({}),
  knowledge: KnowledgeConfigSchema.default({}),
  docFirst: DocFirstConfigSchema.default({}),
  cursor: CursorConfigSchema.default({}),
  harness: HarnessConfigSchema.default({}),
}).strict();

export type HelmConfig = z.infer<typeof HelmConfigSchema>;
export type LarkConfig = z.infer<typeof LarkConfigSchema>;
export type KnowledgeProviderConfig = z.infer<typeof KnowledgeProviderConfigSchema>;
export type DepscopeMapping = z.infer<typeof DepscopeMappingSchema>;

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
