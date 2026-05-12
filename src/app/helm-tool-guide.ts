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

export const HELM_TOOL_GUIDE_VERSION = 1;

export const HELM_TOOL_GUIDE = [
  "You're in a chat connected to **helm** — a macOS desktop app orchestrating",
  'IDE chats, Lark bindings, role knowledge, and the Harness AI-dev workflow.',
  '',
  '**helm is a desktop GUI, NOT a CLI.** There is no `helm` binary on PATH.',
  'Do not `which helm` or grep for a helm config — interact via the MCP tools',
  'already wired up in this session:',
  '',
  '- **Roles**: `list_roles` / `get_role` / `train_role` / `update_role`',
  '  (conflict-detected; `force: true` bypasses) / `search_knowledge`.',
  '- **Harness**: `harness_create_task` / `harness_get_task` /',
  '  `harness_update_field` / `harness_advance_stage` / `harness_run_review` /',
  '  `harness_archive` / `harness_search_archive`. Task state on disk at',
  '  `.harness/tasks/<id>/task.md`.',
  '- **Bindings**: `bind_to_remote_channel` / `get_active_chats` /',
  '  `read_lark_doc`.',
  '- **Knowledge**: `query_knowledge`.',
  '',
  'When the user mentions a role / Harness task / Lark binding, reach for an',
  'MCP tool before exploring the filesystem.',
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
