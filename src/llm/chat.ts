/**
 * LLM chat client abstraction (Phase 57).
 *
 * The existing `LlmClient` (src/summarizer/campaign.ts) is single-shot
 * `generate(prompt) → text`, sufficient for summarize_campaign but not
 * multi-turn flows. Role training is conversational: the user iteratively
 * articulates an expert's persona / knowledge through several turns; only
 * at the end does the final role spec get distilled.
 *
 * Two backends:
 *   - Cursor (`@cursor/sdk`): reuses the user's local Cursor app auth,
 *     zero-config for users who already have Cursor signed in.
 *   - Anthropic (`@anthropic-ai/sdk`): direct Messages API with the user's
 *     own ANTHROPIC_API_KEY (or the key set in helm Settings).
 *
 * Provider selection happens in `createLlmChatClient` based on what's
 * configured — anthropic.apiKey wins when set; otherwise we fall back to
 * Cursor (which works in local mode without any key when Cursor is
 * installed). Tests inject a fake client directly via dep override.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Agent } from '@cursor/sdk';
import type { HelmConfig } from '../config/schema.js';
import type { ToolCallRecord, ToolDef } from './tools/types.js';

export type { ToolDef, ToolCallRecord } from './tools/types.js';

export type LlmChatRole = 'user' | 'assistant';

export interface LlmChatMessage {
  role: LlmChatRole;
  content: string;
}

export interface LlmChatOptions {
  /**
   * System prompt prepended to the conversation. Both providers accept it
   * separately from the message list — Anthropic via the `system` field,
   * Cursor by interpolating into the first prompt.
   */
  system?: string;
  /** Soft cap on response tokens. Anthropic respects it; Cursor ignores. */
  maxTokens?: number;
  /** Override the configured model id. Defaults to provider-appropriate value. */
  model?: string;
  /**
   * Phase 58: tools the LLM may call during this turn. Currently honored
   * by AnthropicChatClient via the Messages API's tool_use loop;
   * CursorChatClient ignores them (Cursor agents have their own tool
   * surface — for now Anthropic is the path with Lark integration).
   */
  tools?: readonly ToolDef[];
  /** Safety cap on tool-use iterations per turn. Default 6. */
  maxToolIterations?: number;
}

export interface LlmChatResult {
  /** Plain-text assistant reply. */
  content: string;
  /** Which provider answered — useful for the renderer to display "via Anthropic" / "via Cursor". */
  provider: 'cursor' | 'anthropic';
  /** Provider-specific model id actually used (for diagnostics + Settings echo). */
  model: string;
  /**
   * Phase 58: every tool the LLM invoked during this turn, in order.
   * Empty when no tools were called. The renderer surfaces these inline
   * so the user sees what the coach did (e.g. "📄 read_lark_doc(...)")
   * before reading the textual reply.
   */
  toolCalls?: ToolCallRecord[];
}

export interface LlmChatClient {
  readonly provider: 'cursor' | 'anthropic';
  /** Resolved model id this client will use. */
  readonly model: string;
  chat(messages: readonly LlmChatMessage[], options?: LlmChatOptions): Promise<LlmChatResult>;
}

// ── Anthropic ───────────────────────────────────────────────────────────

export interface AnthropicChatClientOptions {
  apiKey: string;
  /** Defaults to `claude-sonnet-4-5` (small & cheap, suitable for role-coach role-play). */
  model?: string;
  /** Test seam — inject a fake client. */
  client?: Anthropic;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

export class AnthropicChatClient implements LlmChatClient {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicChatClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error('AnthropicChatClient requires apiKey');
    }
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  async chat(messages: readonly LlmChatMessage[], options: LlmChatOptions = {}): Promise<LlmChatResult> {
    const model = options.model ?? this.model;
    const tools = options.tools ?? [];
    const maxIters = Math.max(1, options.maxToolIterations ?? 6);
    const toolCalls: ToolCallRecord[] = [];

    // Anthropic Messages API content is an array of blocks. We start with
    // the user's plain-text turns; once a tool is used we append the
    // assistant's tool_use block + a `user`-role message containing the
    // matching tool_result blocks, then loop until stop_reason === 'end_turn'.
    const running: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role, content: m.content,
    }));

    for (let i = 0; i < maxIters; i++) {
      const response: Anthropic.Message = await this.client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 2048,
        ...(options.system ? { system: options.system } : {}),
        ...(tools.length > 0
          ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
          : {}),
        messages: running,
      });

      if (response.stop_reason !== 'tool_use') {
        const content = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return {
          content,
          provider: 'anthropic',
          model,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };
      }

      // Persist the assistant's tool_use turn before running the tools, so
      // a thrown tool error still leaves a coherent transcript on retry.
      running.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const def = tools.find((t) => t.name === use.name);
        if (!def) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Tool "${use.name}" is not registered. Available: ${tools.map((t) => t.name).join(', ') || '(none)'}`,
            is_error: true,
          });
          toolCalls.push({ name: use.name, input: use.input, resultPreview: 'tool not registered', error: true });
          continue;
        }
        try {
          const result = await def.run(use.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: result.content,
          });
          toolCalls.push({
            name: use.name,
            input: use.input,
            resultPreview: result.content.slice(0, 200),
          });
        } catch (err) {
          const msg = (err as Error).message;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: msg,
            is_error: true,
          });
          toolCalls.push({ name: use.name, input: use.input, resultPreview: msg.slice(0, 200), error: true });
        }
      }
      running.push({ role: 'user', content: toolResults });
    }

    throw new Error(
      `AnthropicChatClient: tool-use loop exceeded ${maxIters} iterations (likely a tool/LLM ping-pong). `
      + `Tools called so far: ${toolCalls.map((c) => c.name).join(', ')}`,
    );
  }
}

// ── Cursor ──────────────────────────────────────────────────────────────

export interface CursorChatClientOptions {
  /** Optional cloud-mode API key. Local mode (default) uses Cursor app auth. */
  apiKey?: string;
  /** Default 'auto'. */
  model?: string;
  mode?: 'local' | 'cloud';
  /**
   * Phase 59: working directory the agent has file access to. When set, the
   * agent's built-in `read` / `glob` / `grep` / `shell` / `edit` tools
   * operate against this path — gives the role-trainer "read code" without
   * us having to define those tools ourselves. Defaults to `process.cwd()`
   * when unset (helm's own checkout, not super useful — caller should
   * supply the user's project path).
   */
  cwd?: string;
  /**
   * Phase 59: helm's own MCP HTTP/SSE URL. When set, the Cursor agent
   * mounts it as an MCP server and gains access to all helm tools — most
   * notably `read_lark_doc` so the agent can pull Lark docs into context.
   * Typically `http://127.0.0.1:17317/mcp/sse`.
   */
  helmMcpUrl?: string;
  /**
   * Phase 59: test seam — inject a fake `Agent.create`-compatible factory.
   * Fake returns an SDKAgent-shaped object whose `send()` returns a Run
   * whose `stream()` yields fake SDKMessage events.
   */
  agentFactory?: typeof Agent.create;
}

const DEFAULT_CURSOR_MODEL = 'auto';

/**
 * Phase 59: rewritten on top of `Agent.create() + agent.send().stream()`
 * (the pattern shown in the cursor cookbook). Each call to `chat()`:
 *
 *   1. Creates a fresh agent — stateless from helm's HTTP-request lifecycle
 *      perspective; each turn replays the conversation as a single prompt
 *      that the agent works through with its built-in tools.
 *   2. Mounts helm's MCP server (when `helmMcpUrl` is set) so the agent has
 *      `read_lark_doc` (and any future helm tools) available alongside its
 *      own native `read`/`grep`/`shell`/`edit` tools.
 *   3. Streams the run, capturing tool_call events into `toolCalls[]` so
 *      the renderer can render chips inline (same shape as the Anthropic
 *      path).
 *
 * The `tools` field on `LlmChatOptions` is intentionally ignored on this
 * path — Cursor agents have their own tool surface (built-ins + MCP) that
 * doesn't fit our `ToolDef` shape. Helm-side tools should be exposed via
 * the MCP server so both providers can use them.
 */
export class CursorChatClient implements LlmChatClient {
  readonly provider = 'cursor' as const;
  readonly model: string;
  private readonly options: CursorChatClientOptions;

  constructor(options: CursorChatClientOptions = {}) {
    this.options = options;
    this.model = options.model ?? DEFAULT_CURSOR_MODEL;
  }

  async chat(messages: readonly LlmChatMessage[], options: LlmChatOptions = {}): Promise<LlmChatResult> {
    const agentCreate = this.options.agentFactory ?? Agent.create;
    const transcript = serializeTranscript(messages, options.system);

    const createOptions: Parameters<typeof Agent.create>[0] = {
      name: 'helm role-coach',
      model: { id: options.model ?? this.model },
    };
    if (this.options.mode === 'local' || !this.options.mode) {
      createOptions.local = { cwd: this.options.cwd ?? process.cwd() };
    } else if (this.options.apiKey) {
      createOptions.apiKey = this.options.apiKey;
    }
    if (this.options.helmMcpUrl) {
      createOptions.mcpServers = {
        helm: { type: 'sse', url: this.options.helmMcpUrl },
      };
    }

    const agent = await agentCreate(createOptions);
    const toolCalls: ToolCallRecord[] = [];
    let assistantText = '';

    try {
      const run = await agent.send(transcript);

      for await (const event of run.stream()) {
        // Streaming SDKMessage events. Two shapes that matter for us:
        //   - `assistant` with content blocks (text + tool_use);
        //   - `tool_call` with status updates (requested, running, completed).
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              assistantText += block.text;
            } else if (block.type === 'tool_use') {
              // Insert a placeholder so order is preserved; the matching
              // `tool_call` event with status=completed will fill in the
              // resultPreview if the SDK surfaces it.
              toolCalls.push({
                name: block.name,
                input: block.input,
                resultPreview: '',
              });
            }
          }
        } else if (event.type === 'tool_call') {
          // Update the in-flight tool call with the latest status. The
          // SDK emits multiple tool_call events per tool (requested →
          // running → completed); only "completed" carries a result.
          // Our shape is a flat list so we update the most recent call
          // matching the name + input.
          const status = (event as { status?: string }).status;
          const name = (event as { name?: string }).name ?? '';
          const args = (event as { args?: unknown }).args;
          const result = (event as { result?: unknown }).result;
          if (status === 'completed' || status === 'failed') {
            const matchIdx = findLastMatchingToolCall(toolCalls, name, args);
            const target = matchIdx >= 0
              ? toolCalls[matchIdx]!
              : (toolCalls.push({ name, input: args, resultPreview: '' }), toolCalls[toolCalls.length - 1]!);
            target.resultPreview = stringifyForPreview(result).slice(0, 200);
            if (status === 'failed') target.error = true;
          }
        }
      }

      const result = await run.wait();
      if (result.status !== 'finished') {
        throw new Error(
          `Cursor agent did not finish (status=${result.status})`
          + (result.result ? `: ${result.result.slice(0, 200)}` : ''),
        );
      }
      // Some agent runs deliver the final answer only via run.result rather
      // than streamed assistant text. Use whichever is non-empty.
      const content = assistantText || (result.result ?? '');
      return {
        content,
        provider: 'cursor',
        model: options.model ?? this.model,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } finally {
      // Best-effort dispose — the SDK exposes Symbol.asyncDispose on agents.
      try { await agent[Symbol.asyncDispose](); } catch { /* ignored */ }
    }
  }
}

function findLastMatchingToolCall(
  calls: readonly ToolCallRecord[],
  name: string,
  args: unknown,
): number {
  // Walk backwards because tool_call events arrive shortly after the
  // assistant's tool_use block; the most recent insertion is almost always
  // the right match.
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (c.name === name && deepEqual(c.input, args)) return i;
  }
  return -1;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

function stringifyForPreview(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function serializeTranscript(messages: readonly LlmChatMessage[], system?: string): string {
  const parts: string[] = [];
  if (system) {
    parts.push(`System:\n${system}\n`);
  }
  for (const m of messages) {
    const tag = m.role === 'user' ? 'User' : 'Assistant';
    parts.push(`${tag}:\n${m.content}\n`);
  }
  parts.push('Assistant:\n');
  return parts.join('\n');
}

// ── Factory ─────────────────────────────────────────────────────────────

export interface CreateLlmChatClientDeps {
  config: HelmConfig;
  /**
   * Phase 59: working directory the Cursor agent has file access to.
   * Forwarded as `local: { cwd }` when the Cursor backend is selected.
   * Doesn't affect the Anthropic backend (no file access there).
   */
  cwd?: string;
  /**
   * Phase 59: helm MCP server URL. When set + Cursor backend is selected,
   * the agent mounts helm's MCP via SSE and gains `read_lark_doc` etc.
   */
  helmMcpUrl?: string;
  /** Test override — return a fake client. */
  factory?: (config: HelmConfig) => LlmChatClient;
}

/**
 * Pick a provider based on what the user configured:
 *   1. If `anthropic.apiKey` is set → AnthropicChatClient (highest priority;
 *      explicit user choice).
 *   2. Else if cursor mode is local OR cloud-with-key → CursorChatClient.
 *   3. Else throw — caller surfaces the actionable error.
 *
 * Throws on no usable provider so the HTTP endpoint can surface a 501 with
 * a clear "set anthropic.apiKey or sign into Cursor" message.
 */
export function createLlmChatClient(deps: CreateLlmChatClientDeps): LlmChatClient {
  if (deps.factory) return deps.factory(deps.config);

  const anthropicKey = deps.config.anthropic?.apiKey?.trim();
  if (anthropicKey) {
    return new AnthropicChatClient({
      apiKey: anthropicKey,
      ...(deps.config.anthropic?.model ? { model: deps.config.anthropic.model } : {}),
    });
  }

  // Cursor local mode works without a key; cloud needs CURSOR_API_KEY.
  const cursorMode = deps.config.cursor.mode ?? 'local';
  const cursorKey = deps.config.cursor.apiKey?.trim() || process.env['CURSOR_API_KEY']?.trim();
  if (cursorMode === 'local' || cursorKey) {
    return new CursorChatClient({
      mode: cursorMode,
      ...(cursorKey ? { apiKey: cursorKey } : {}),
      ...(deps.config.cursor.model ? { model: deps.config.cursor.model } : {}),
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      ...(deps.helmMcpUrl ? { helmMcpUrl: deps.helmMcpUrl } : {}),
    });
  }

  throw new Error(
    'No LLM provider configured. Set `anthropic.apiKey` in helm Settings, '
    + 'or sign into the Cursor app on this machine.',
  );
}
