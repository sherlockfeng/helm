/**
 * `read_lark_doc` tool — lets the role-trainer coach pull a Lark / Feishu
 * document into the conversation (Phase 58).
 *
 * Implementation detail: `lark-cli docs +fetch --api-version v2 --doc <URL>`
 * accepts a wiki OR docx URL directly and returns the parsed document. We
 * ask for `--doc-format markdown` so the LLM gets clean structured text
 * (the default XML is too noisy for context-window usage).
 *
 * The tool truncates output at 16 KB to avoid blowing the LLM's context on
 * a single doc; if the user wants more, they can paste a section URL.
 */

import type { LarkCliRunner } from '../../channel/lark/cli-runner.js';
import type { ToolDef } from './types.js';

const MAX_RETURN_BYTES = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ReadLarkDocOptions {
  cli: LarkCliRunner;
  /** Override timeout for tests (defaults 60s — large docs can be slow). */
  timeoutMs?: number;
}

export function createReadLarkDocTool(options: ReadLarkDocOptions): ToolDef {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: 'read_lark_doc',
    description:
      'Read the content of a Lark / Feishu document. Accepts a full URL '
      + '(wiki or docx) or a bare doc token. Returns markdown — the docs are '
      + 'truncated at 16KB if very long. Use this when the user references a '
      + 'doc that informs the role you are coaching them through.',
    inputSchema: {
      type: 'object',
      properties: {
        url_or_token: {
          type: 'string',
          description:
            'Full URL like https://your-org.feishu.cn/wiki/xxxx or '
            + 'https://your-org.feishu.cn/docx/xxxx, or a bare token.',
        },
      },
      required: ['url_or_token'],
    },
    async run(rawInput) {
      const ref = extractRef(rawInput);
      const result = await options.cli.run(
        [
          'docs', '+fetch',
          '--api-version', 'v2',
          '--doc', ref,
          '--doc-format', 'markdown',
          '--as', 'user',
        ],
        { timeoutMs },
      );
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(0, 400);
        throw new Error(
          `lark-cli docs +fetch failed (code=${result.exitCode}): ${detail || '(no output)'}`,
        );
      }

      // lark-cli wraps the doc in a JSON envelope by default; --jq could
      // narrow it, but jq isn't always available on the CLI build. Parse
      // here and walk the most common shapes.
      const text = extractMarkdown(result.stdout);
      const truncated = text.length > MAX_RETURN_BYTES
        ? `${text.slice(0, MAX_RETURN_BYTES)}\n\n[... truncated, ${text.length - MAX_RETURN_BYTES} more bytes ...]`
        : text;
      return { content: truncated };
    },
  };
}

function extractRef(rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new Error('read_lark_doc input must be { url_or_token: string }');
  }
  const v = (rawInput as Record<string, unknown>)['url_or_token'];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error('read_lark_doc input.url_or_token must be a non-empty string');
  }
  const trimmed = v.trim();
  // Defensive: lark-cli accepts URLs and tokens both, but reject anything
  // wildly off-shape so we don't invoke the CLI with a shell metacharacter.
  if (/[\s;|`$&<>]/.test(trimmed)) {
    throw new Error(`read_lark_doc rejected suspicious input: ${trimmed.slice(0, 60)}`);
  }
  return trimmed;
}

/**
 * lark-cli's JSON output for `docs +fetch` typically wraps content under
 * `data.content` (markdown string) or similar. Walk a few likely paths and
 * fall back to the raw stdout when nothing matches — the LLM can still
 * make sense of it.
 */
function extractMarkdown(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    const candidates = [
      parsed?.data?.content,
      parsed?.data?.document?.content,
      parsed?.content,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c;
    }
    // Last-resort: stringify the whole `data` payload so the LLM at least
    // sees structured content.
    if (parsed?.data) return JSON.stringify(parsed.data, null, 2);
    return trimmed;
  } catch {
    return trimmed; // not JSON — probably raw markdown already
  }
}
