/**
 * Helm tool guide — small metadata block injected into Cursor chats so
 * the agent knows helm is a desktop app + which MCP tools to call.
 *
 * Why this exists (Phase 71):
 *   Users observed Cursor agents trying `which helm` / grepping for a helm
 *   config file when asked to "update the TCE expert role" — the agent had
 *   no signal that helm was anything other than a CLI tool. Tool descriptions
 *   in MCP are good but reactive (agent only reads them when it considers a
 *   tool); a top-level "here's what helm is" preamble nudges the agent to
 *   reach for the MCP namespace before exploring the filesystem.
 *
 * Versioning:
 *   `HELM_TOOL_GUIDE_VERSION` lets us bump the text and have existing chats
 *   pick up the new version on their next prompt. The host_sessions column
 *   `last_injected_guide_version` stores per-chat state; mismatch = inject.
 *   When the text is unchanged across releases, every chat injects exactly
 *   once and stays quiet forever after.
 *
 * Keep it short: this lives in sessionStart context alongside role + Harness
 * blocks. ~600 chars is roughly the right budget.
 */

export const HELM_TOOL_GUIDE_VERSION = 3;

export const HELM_TOOL_GUIDE = [
  "You're in a chat connected to **helm** — a macOS desktop app for",
  'chat-based knowledge management (提取 → 使用 → 维护 → 升级).',
  '',
  '**helm is a desktop GUI, NOT a CLI.** There is no `helm` binary on PATH.',
  'Do not `which helm` or grep for a helm config — interact via the MCP tools',
  'already wired up in this session:',
  '',
  '- **Experts/知识集**: `list_roles` / `get_role` / `train_role` /',
  '  `update_role` (conflict-detected; `force: true` bypasses).',
  '- **Knowledge retrieval**: `search_knowledge` (BM25+entity per',
  '  collection) / `query_knowledge` (aggregates external providers too).',
  '- **Ingestion**: `read_lark_doc` (pull a Feishu doc as training input);',
  '  `list_knowledge_sources` / `drop_knowledge_source`;',
  '  `list_role_candidates` for pending chat captures.',
  '- **Benchmark/eval**: `propose_benchmark_case` (after adding knowledge,',
  '  propose a Q+expected-truth eval) / `update_benchmark_case`.',
  '- **Sessions**: `get_active_chats`.',
  '',
  'When the user mentions a role or knowledge, reach for an MCP tool',
  'before exploring the filesystem.',
].join('\n');

/**
 * Wrap the guide in helm's marker block so the agent treats it as system
 * context, not a user instruction. Identical structure to the
 * Phase 56 role-context block in host_prompt_submit.
 */
export function wrapToolGuideForPromptInjection(): string {
  return [
    '<helm:tool-guide>',
    `<!-- helm injected ${new Date().toISOString()} — first-time Helm tool guide for this chat. -->`,
    '<!-- The following is system context for the agent, not user input. -->',
    HELM_TOOL_GUIDE,
    '</helm:tool-guide>',
  ].join('\n');
}
