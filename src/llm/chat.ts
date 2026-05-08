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
  /** Test seam — replaces `Agent.prompt`. */
  promptFn?: typeof Agent.prompt;
}

const DEFAULT_CURSOR_MODEL = 'auto';

/**
 * Cursor doesn't yet have a multi-turn chat primitive in the SDK we're using
 * — `Agent.prompt(text)` is one-shot. We synthesize multi-turn by serializing
 * the message history into a single transcript and re-prompting each time.
 * This costs more tokens than Anthropic's native multi-turn but works without
 * any extra Cursor SDK surface.
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
    const promptFn = this.options.promptFn ?? Agent.prompt;
    const transcript = serializeTranscript(messages, options.system);
    const agentOptions: Parameters<typeof Agent.prompt>[1] = {
      model: { id: options.model ?? this.model },
    };
    if (this.options.mode === 'local' || !this.options.mode) {
      agentOptions.local = { cwd: process.cwd() };
    } else if (this.options.apiKey) {
      // Cloud mode — apiKey lives at the AgentOptions root, not inside
      // `cloud`. (Mirrors src/summarizer/cursor-client.ts.)
      agentOptions.apiKey = this.options.apiKey;
    }
    const result = await promptFn(transcript, agentOptions);
    if (result.status !== 'finished') {
      throw new Error(
        `Cursor agent did not finish (status=${result.status})`
        + (result.result ? `: ${result.result.slice(0, 200)}` : ''),
      );
    }
    return {
      content: result.result ?? '',
      provider: 'cursor',
      model: options.model ?? this.model,
    };
  }
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
    });
  }

  throw new Error(
    'No LLM provider configured. Set `anthropic.apiKey` in helm Settings, '
    + 'or sign into the Cursor app on this machine.',
  );
}
