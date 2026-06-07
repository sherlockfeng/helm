/**
 * Conversations — PR 1 alias for the existing Active Chats surface.
 *
 * Per design §2 the Conversations page is the new landing page, with
 * Cursor / Claude Code / Codex facet tabs. PR 1 reuses the existing
 * ChatsPage; the facet tabs and three-pane detail view (§5.1 / §5.2)
 * arrive in PR 3 once retrieval_log and agentKind are persisted.
 */

export { ChatsPage as ConversationsPage } from './Chats.js';
