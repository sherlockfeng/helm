/**
 * Tool definitions handed to LLM chat clients (Phase 58).
 *
 * Mirrors the Anthropic Messages API shape so AnthropicChatClient can pass
 * them through with minimal translation. The `run` callback executes the
 * tool and returns text content the LLM sees as `tool_result`. Errors are
 * caught at the loop level and surfaced as `is_error: true` results so the
 * model can decide whether to retry / fall back to text.
 */

export interface ToolDef {
  /** Stable name matching ^[a-z][a-z0-9_]*$. The LLM references this. */
  name: string;
  /** Human-readable description. The LLM uses this to decide when to call. */
  description: string;
  /**
   * JSON Schema describing the tool's input. Anthropic's API accepts this
   * verbatim. Keep it minimal — required fields + obvious types.
   */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * Execute the tool. Return text content the LLM will see; throw on
   * unrecoverable failure (the caller catches and feeds the error back as
   * `is_error: true`).
   */
  run(input: unknown): Promise<{ content: string }>;
}

/**
 * Snapshot of a single tool call that happened during a chat turn — used by
 * the renderer to show the user what the coach was doing (e.g. "📄 reading
 * doc…"). The transcript itself only carries text content; tool calls are
 * surfaced separately so the UI can render them with affordances.
 */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  /** Truncated to ~200 chars for the UI; full output is in the LLM context. */
  resultPreview: string;
  /** True when the tool threw; renderer styles errors differently. */
  error?: boolean;
}
