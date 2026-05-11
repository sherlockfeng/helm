/**
 * "Format pass" retry for LLM JSON output (Phase 68).
 *
 * Per fork #9: claude's summarize/review prompts ask for strict JSON, but
 * Claude occasionally returns prose-wrapped JSON, trailing commentary, or
 * mid-array truncation. Rather than refuse the response, we ask the same
 * engine to FIX its own output: feed it the raw text + a terse "return
 * valid JSON only, no commentary" instruction. One retry. If the second
 * pass also fails to parse, surface the parse error to the caller with
 * both attempts attached for debugging.
 *
 * Why one retry and not N: empirically (and per the prompt-engineering
 * literature) single-shot fixes catch >95% of cases. More attempts mostly
 * indicate the underlying prompt is wrong; a 3rd attempt won't fix that.
 */

export interface JsonRetryOptions {
  /** First-pass output from the engine. */
  raw: string;
  /**
   * Re-invokes the engine with a "fix this output to valid JSON" prompt.
   * Returns the second attempt's raw text.
   */
  formatPass: (raw: string) => Promise<string>;
}

export class JsonParseAfterRetryError extends Error {
  constructor(
    public readonly firstAttempt: string,
    public readonly secondAttempt: string,
    public readonly firstError: string,
    public readonly secondError: string,
  ) {
    super(
      `LLM output didn't parse as JSON on first OR retry pass. `
      + `first error: ${firstError}; retry error: ${secondError}`,
    );
    this.name = 'JsonParseAfterRetryError';
  }
}

/**
 * Try `JSON.parse(raw)`; on failure, ask the engine to reformat, then
 * try again. Throws `JsonParseAfterRetryError` if both attempts fail.
 *
 * Returns the parsed value typed as `unknown` — the caller validates the
 * shape (usually via zod or hand-written type guards).
 */
export async function parseJsonWithFormatRetry(opts: JsonRetryOptions): Promise<unknown> {
  const stripped = stripFences(opts.raw);
  try {
    return JSON.parse(stripped);
  } catch (firstErr) {
    const secondRaw = await opts.formatPass(opts.raw);
    const secondStripped = stripFences(secondRaw);
    try {
      return JSON.parse(secondStripped);
    } catch (secondErr) {
      throw new JsonParseAfterRetryError(
        opts.raw, secondRaw,
        (firstErr as Error).message,
        (secondErr as Error).message,
      );
    }
  }
}

/**
 * Strip common Markdown fences claude sometimes emits around JSON:
 *   ```json
 *   { ... }
 *   ```
 *   ```
 *   { ... }
 *   ```
 * No-op on plain JSON. Anything other than the fenced block is preserved
 * so that JSON.parse will still throw if the response is e.g. prose-wrapped.
 */
export function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) return fenced[1]!.trim();
  return trimmed;
}

/**
 * Standard "fix the JSON" reprompt — what `claudeAdapter.summarize` /
 * `claudeAdapter.review` pass to the engine on retry. Exported so future
 * adapters (cursor / others) can reuse the exact same instruction text.
 */
export function formatPassPrompt(raw: string): string {
  return [
    'The previous response did not parse as valid JSON. Re-output the SAME content,',
    'but as valid JSON only — no prose, no markdown fences, no leading or trailing',
    'commentary. If the original had a structural defect (missing comma, unbalanced',
    'bracket, trailing comment), fix it. Preserve all semantic content.',
    '',
    '--- previous response ---',
    raw,
    '--- end ---',
    '',
    'Now output the corrected JSON.',
  ].join('\n');
}
