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

export const HelmConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  approval: ApprovalConfigSchema.default({}),
  lark: LarkConfigSchema.default({}),
  knowledge: KnowledgeConfigSchema.default({}),
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
