/**
 * HTTP-backed CompletionClient (PR 5b).
 *
 * One-shot POST against an OpenAI-compatible `/chat/completions` style
 * endpoint. Same shape llm-wiki and most provider docs converge on, so
 * the same provider.json configs work everywhere.
 *
 * Deliberately small: helm only needs single-turn answer + single-turn
 * judge, no streaming, no tools, no function-calling. Avoiding the
 * Anthropic SDK / openai SDK keeps the dep graph slim and lets the
 * provider config dictate baseUrl freely (Azure, OpenRouter, modhub,
 * vLLM, etc.).
 *
 * Errors fold into a single typed class so the runner can surface a
 * precise reason in benchmark_run.judge_verdict_text when the call
 * fails for non-LLM reasons (network, 4xx, timeout).
 */

import type { CompletionClient } from './runner.js';
import type { ResolvedProvider } from './provider-config.js';

export class HttpLlmError extends Error {
  override readonly name = 'HttpLlmError';
  constructor(
    msg: string,
    public readonly stage: 'request' | 'response' | 'parse' | 'timeout' | 'http',
    public readonly status?: number,
  ) {
    super(msg);
  }
}

export interface HttpLlmClientOptions {
  /**
   * Per-call timeout. Default 60s — most chat completions return in
   * under 30s; 60s allows for slow judge models without leaving a
   * runaway request hanging forever.
   */
  timeoutMs?: number;
  /**
   * fetch override for tests. Production binds to the global fetch.
   * The signature matches the Web Fetch API so callers can pass a
   * MSW-style or undici-style mock without ceremony.
   */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** Cap output. Mirrors llm-wiki's `maxTokens` clamp. */
  max_tokens?: number;
  /** Hint at sampling; we don't read it back but providers respect it. */
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class HttpLlmClient implements CompletionClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpLlmClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(args: {
    provider: ResolvedProvider;
    systemPrompt?: string;
    userPrompt: string;
    maxOutputTokens?: number;
  }): Promise<{ text: string; costUsd?: number }> {
    const { provider, systemPrompt, userPrompt, maxOutputTokens } = args;
    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const body: ChatCompletionRequest = {
      model: provider.model.id,
      messages,
      max_tokens: Math.min(
        maxOutputTokens ?? provider.model.maxTokens,
        provider.model.maxTokens,
      ),
    };

    const url = buildUrl(provider.model.baseUrl);
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error('helm http-llm timeout')),
      this.timeoutMs,
    );

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
          ...provider.model.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.message?.includes('timeout') || (e as { name?: string }).name === 'AbortError') {
        throw new HttpLlmError(`request timed out after ${this.timeoutMs}ms`, 'timeout');
      }
      throw new HttpLlmError(`request failed: ${e.message}`, 'request');
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      // Read the body but cap at 1k chars so a verbose 500 page doesn't
      // dominate the error message landing in benchmark_run.
      let bodyText = '';
      try { bodyText = (await response.text()).slice(0, 1024); }
      catch { /* swallow */ }
      throw new HttpLlmError(
        `HTTP ${response.status} from ${provider.id}: ${bodyText || '(empty body)'}`,
        'http',
        response.status,
      );
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = await response.json() as ChatCompletionResponse;
    } catch (err) {
      throw new HttpLlmError(
        `response was not valid JSON: ${(err as Error).message}`,
        'parse',
      );
    }

    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) {
      throw new HttpLlmError(
        `response had no message content (choices=${JSON.stringify(parsed.choices)})`,
        'response',
      );
    }

    return {
      text,
      ...(estimateCost(provider, parsed.usage) !== undefined
        ? { costUsd: estimateCost(provider, parsed.usage)! }
        : {}),
    };
  }
}

/**
 * Compute USD cost from the response's token usage when the provider's
 * model.cost block is filled in. Most providers return token counts in
 * an OpenAI-compatible `usage` object; when that's missing we return
 * undefined and the runner falls back to LLM-call-count cost accounting.
 */
function estimateCost(
  provider: ResolvedProvider,
  usage: ChatCompletionResponse['usage'],
): number | undefined {
  const c = provider.model.cost;
  if (!c || !usage) return undefined;
  const inTokens = usage.prompt_tokens ?? 0;
  const outTokens = usage.completion_tokens ?? 0;
  // model.cost values are conventionally per 1M tokens; divide before
  // multiplying so the math stays in floating-point range. If a config
  // ever uses per-1k pricing it just produces a 1000x estimate — easy
  // to spot in the Insights cost chart.
  return (inTokens * c.input + outTokens * c.output) / 1_000_000;
}

function buildUrl(baseUrl: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  // Permit both bare base ("https://api.openai.com/v1") and an already-
  // full chat path. The latter helps providers like Azure that expect
  // a deployment-scoped URL.
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}
