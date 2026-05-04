/**
 * Parse Lark message text into typed command intents.
 *
 * Two grammars merged here:
 *
 *   1. Approval commands (PROJECT_BLUEPRINT.md §12.2):
 *        /allow         /deny
 *        /allow!        /deny!                  — remember inferred scope
 *        /allow <id>    /deny <id>              — target a specific pending
 *        /allow shell!  /allow pnpm!            — scoped tool / command prefix
 *        /allow mcp__server__tool!              — exact mcp tool match
 *      Optional `cursor:` prefix (e.g. `/cursor: allow`) is accepted.
 *
 *   2. Lifecycle commands (require @bot mention to fire):
 *        bind chat / 绑定对话                     — start a binding handshake
 *        unbind / un bind / 解除绑定 / 解绑       — drop this thread's binding
 *        stop wait / disable wait / pause wait   — disable wait loop
 *        /help                                   — show inline help
 *
 * The parser is pure; the listener decides whether @bot was mentioned.
 */

export type CommandIntent =
  | { kind: 'approval'; decision: 'allow' | 'deny'; remember: boolean; targetId?: string; scope?: string }
  | { kind: 'bind' }
  | { kind: 'unbind' }
  | { kind: 'disable_wait' }
  | { kind: 'help' }
  | { kind: 'unknown' };

export interface ParseInput {
  /** Raw message text. */
  text: string;
  /** Whether the message mentioned the bot. Lifecycle commands require this. */
  mentioned?: boolean;
}

const APPROVAL_RE = /(?:^|\s)\/(?:cursor[:\s]+)?(allow|deny)(!)?(?:\s+(.+?))?\s*$/i;
const BIND_CHAT_RE = /\b(bind\s+chat)\b|绑定对话/i;
const UNBIND_RE = /\b(?:un\s*bind|unbind)(?:\s+(?:chat|thread))?\b|解除绑定|解绑/i;
const DISABLE_WAIT_RE = /\b(stop|disable|pause)\s+wait(?:ing)?\b|(?:停止|关闭)\s*等待/i;
const HELP_RE = /(?:^|\s)(?:\/help|help|帮助)\s*$/i;

/** Tools that may appear bare in `/allow <tool>!`. Case-insensitive match. */
const KNOWN_TOOL_KEYWORDS = new Set([
  'shell', 'bash', 'write', 'edit', 'delete', 'applypatch', 'multiedit', 'mcp',
]);

function looksLikeMcpToolName(value: string): boolean {
  return /^mcp__[\w.-]+/.test(value);
}

function classifyApprovalScope(suffix: string | undefined, remember: boolean): { targetId?: string; scope?: string } {
  if (!suffix) return {};
  const trimmed = suffix.trim();
  if (!trimmed) return {};

  // `/allow!` with no suffix is handled by the caller (suffix === undefined).
  // With a suffix, decide between targetId / tool-scope / pkg-prefix:
  //   /allow <hex_id>          → targetId
  //   /allow! shell            → scope = 'shell' (tool wildcard)
  //   /allow! pnpm install     → scope = 'pnpm install' (command prefix)
  //   /allow! mcp__svc__do     → scope = 'mcp__svc__do'
  //
  // The `remember` flag (the trailing `!` in /allow! or /allow shell!) only
  // makes sense for scoped variants. When suffix is present without
  // remember, we still attempt to interpret it as an id selector.
  if (!remember) {
    return { targetId: trimmed };
  }

  // remember=true with suffix → it's a scope, not an id.
  if (looksLikeMcpToolName(trimmed)) return { scope: trimmed };
  const firstWord = trimmed.split(/\s+/)[0]!.toLowerCase();
  if (KNOWN_TOOL_KEYWORDS.has(firstWord)) return { scope: trimmed.toLowerCase() };
  return { scope: trimmed };
}

export function parseCommand(input: ParseInput): CommandIntent {
  const text = input.text ?? '';
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'unknown' };

  // Approval commands always work, mention or no — the user is responding to
  // a bot-pushed approval card / message in their thread.
  const approvalMatch = APPROVAL_RE.exec(text);
  if (approvalMatch) {
    const decision = approvalMatch[1]!.toLowerCase() as 'allow' | 'deny';
    const remember = approvalMatch[2] === '!';
    const suffix = approvalMatch[3];
    const scoped = classifyApprovalScope(suffix, remember);
    return { kind: 'approval', decision, remember, ...scoped };
  }

  // Lifecycle commands gate on @bot mention so a casual message containing
  // "bind" doesn't clobber the binding. Order matters: `un bind chat` must
  // match `unbind`, not `bind chat`, so check unbind first.
  const mentioned = Boolean(input.mentioned);
  if (mentioned && UNBIND_RE.test(trimmed)) return { kind: 'unbind' };
  if (mentioned && BIND_CHAT_RE.test(trimmed)) return { kind: 'bind' };
  if (mentioned && DISABLE_WAIT_RE.test(trimmed)) return { kind: 'disable_wait' };

  // /help works mentioned-or-not, but bare "help" only counts when mentioned.
  if (trimmed === '/help' || (mentioned && HELP_RE.test(trimmed))) {
    return { kind: 'help' };
  }

  return { kind: 'unknown' };
}

/** Render the canonical inline help text. */
export function buildHelpText(): string {
  return [
    '**Helm — Lark commands**',
    '',
    '**Binding**',
    '- `@bot bind chat` — generate a binding code for this thread',
    '- `@bot unbind` — drop this thread\'s relay binding',
    '',
    '**Wait loop**',
    '- `@bot stop wait` / `disable wait` / `pause wait` — turn off the continuous-wait loop',
    '',
    '**Approvals**',
    '- `/allow` / `/deny` — decide the latest pending request once',
    '- `/allow <id>` / `/deny <id>` — target a specific pending',
    '- `/allow!` / `/deny!` — decide and remember the inferred scope',
    '- `/allow shell!` / `/allow pnpm!` — scope to a tool / command prefix',
    '- `/allow mcp__server__tool!` — remember one exact MCP tool',
  ].join('\n');
}
