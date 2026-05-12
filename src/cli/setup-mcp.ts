/**
 * `helm setup-mcp <claude|cursor>` — register helm's MCP server with the
 * user's CLI of choice (Phase 60a).
 *
 * Background:
 *   - helm runs an MCP HTTP/SSE server at http://127.0.0.1:17317/mcp/sse
 *     (Phase 45). It exposes `train_role`, `get_active_chats`,
 *     `query_knowledge`, `recall_requirement`, etc.
 *   - For users to invoke those tools from their CLI agent, the CLI has to
 *     know about helm. This command does the registration so the user
 *     doesn't have to remember the URL or hand-edit a config file.
 *
 * Per-tool wiring:
 *   - **claude** (Claude Code) ships its own `claude mcp add` CLI; we
 *     shell out to it with `--scope user --transport sse`. Idempotent: if
 *     `helm` already exists in `claude mcp list`, we no-op (claude mcp add
 *     would error otherwise).
 *   - **cursor** has no CLI; we edit `~/.cursor/mcp.json` directly.
 *     Preserves existing entries. Idempotent: same URL → no rewrite.
 *
 * The endpoint and server name are exported so tests + the renderer's
 * "Train via your CLI" panel can reference the same constants.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Tracks helm's MCP SSE endpoint shape. Single source of truth. */
export const HELM_MCP_NAME = 'helm';
export const HELM_MCP_URL_DEFAULT = 'http://127.0.0.1:17317/mcp/sse';

export type SetupTarget = 'claude' | 'cursor';

export interface SetupMcpResult {
  target: SetupTarget;
  /** True when this run actually changed something. */
  changed: boolean;
  /** Free-form summary suitable for stdout. */
  message: string;
  /** Path the entry landed in (file path or "claude mcp add" invocation). */
  location: string;
}

export interface SetupMcpOptions {
  /** Override the URL (e.g. for non-default `config.server.port`). */
  url?: string;
  /** Override the global config root (tests). Defaults to `~`. */
  homeDir?: string;
  /**
   * For tests: skip the `claude mcp` shell-outs and operate purely on
   * file paths the same way `cursor` mode does.
   */
  claudeFallbackToFile?: boolean;
  /**
   * For tests: stub out the actual command runner. When set, we never
   * spawn a real subprocess.
   */
  exec?: (cmd: string, args: readonly string[]) => string;
}

export function setupMcp(target: SetupTarget, options: SetupMcpOptions = {}): SetupMcpResult {
  const url = options.url ?? HELM_MCP_URL_DEFAULT;
  const home = options.homeDir ?? homedir();

  if (target === 'claude') return setupClaude(url, options, home);
  if (target === 'cursor') return setupCursor(url, home);
  // Exhaustiveness — hit when called from JS without typing.
  throw new Error(`setup-mcp: unknown target "${String(target)}"`);
}

// ── Claude Code ──────────────────────────────────────────────────────────

function setupClaude(url: string, options: SetupMcpOptions, home: string): SetupMcpResult {
  // Test path: skip the `claude` CLI entirely.
  if (options.claudeFallbackToFile) {
    return setupClaudeFallback(url, home);
  }

  const exec = options.exec ?? defaultExec;

  // Probe `claude --version` first so a missing CLI surfaces as a clean
  // error, not a stack trace from the next call. This branch also lets
  // tests stub the whole thing.
  try {
    exec('claude', ['--version']);
  } catch {
    return {
      target: 'claude',
      changed: false,
      message:
        'Claude Code CLI not found. Install it (https://code.claude.com/docs/en/cli-reference)\n'
        + 'or run with `--target=cursor` if you use Cursor instead.',
      location: '(unavailable)',
    };
  }

  // Idempotent check: claude mcp list already shows helm? → no-op.
  let existing = '';
  try { existing = exec('claude', ['mcp', 'list']); } catch { /* fall through */ }
  if (existing.includes(`${HELM_MCP_NAME}:`)) {
    return {
      target: 'claude',
      changed: false,
      message: `helm is already registered in Claude Code's user-scope MCP servers.`,
      location: 'claude mcp (user scope)',
    };
  }

  // claude mcp add --scope user --transport sse helm <url>
  exec('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'sse', HELM_MCP_NAME, url]);
  return {
    target: 'claude',
    changed: true,
    message:
      `Registered helm with Claude Code (user scope, sse, ${url}).\n`
      + `In any Claude Code chat, just say e.g. "把刚才的对话沉淀成 helm 的 tce 专家 role".`,
    location: 'claude mcp (user scope)',
  };
}

function defaultExec(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, [...args], {
    encoding: 'utf8',
    // Claude CLI's mcp commands log to stderr on warnings; don't make the
    // helm command fail just because the user got a "config migrated" notice.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Test-only path: write to ~/.claude.json directly the same way cursor does.
 * The real Claude Code CLI handles its own format — we don't try to
 * reverse-engineer it in production. Tests use this branch so they can run
 * without a real `claude` binary on PATH.
 */
function setupClaudeFallback(url: string, home: string): SetupMcpResult {
  const path = join(home, '.claude.json');
  const result = upsertJsonMcpEntry(path, HELM_MCP_NAME, { type: 'sse', url });
  return {
    target: 'claude',
    changed: result.changed,
    message: result.changed
      ? `Wrote helm MCP entry to ${path} (test fallback).`
      : `helm entry already present in ${path}.`,
    location: path,
  };
}

// ── Cursor ───────────────────────────────────────────────────────────────

function setupCursor(url: string, home: string): SetupMcpResult {
  const path = join(home, '.cursor', 'mcp.json');
  // Phase 75: Cursor 1.x tightened SSE schema validation — an entry with only
  // `url` triggers a confusing "Server 'mcpServers' must have either a
  // command or url" banner because their parser can't infer SSE from `url`
  // alone. Writing `{ type: 'sse', url }` is explicit + accepted by every
  // Cursor version we've seen. Same shape we already use for Claude Code's
  // fallback path, so the two stay symmetric.
  const result = upsertJsonMcpEntry(path, HELM_MCP_NAME, { type: 'sse', url });
  return {
    target: 'cursor',
    changed: result.changed,
    message: result.changed
      ? `Wrote helm MCP entry to ${path}. Restart Cursor to pick it up.`
      : `helm entry already present in ${path} — nothing to do.`,
    location: path,
  };
}

// ── Shared: idempotent JSON edit ─────────────────────────────────────────

interface UpsertResult { changed: boolean }

/**
 * Edit a JSON config file's `mcpServers.<name>` entry. Preserves every
 * other key. Idempotent — if the existing entry already matches `value`
 * exactly, returns `{ changed: false }` and doesn't touch the file.
 *
 * Creates the parent dir + file when missing.
 */
function upsertJsonMcpEntry(
  filePath: string,
  name: string,
  value: Record<string, unknown>,
): UpsertResult {
  let parsed: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (raw) {
      try {
        const candidate = JSON.parse(raw);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          parsed = candidate as Record<string, unknown>;
        }
      } catch (err) {
        throw new Error(
          `setup-mcp: ${filePath} is not valid JSON; refusing to overwrite. `
          + `Original parse error: ${(err as Error).message}`,
        );
      }
    }
  }

  const servers = (parsed['mcpServers'] && typeof parsed['mcpServers'] === 'object'
    && !Array.isArray(parsed['mcpServers']))
    ? { ...(parsed['mcpServers'] as Record<string, unknown>) }
    : {};

  // Already present + identical? → no-op so a re-run doesn't churn the file's
  // mtime / git diff.
  const existing = servers[name];
  if (existing && shallowEqualJson(existing, value)) {
    return { changed: false };
  }

  servers[name] = value;
  parsed['mcpServers'] = servers;

  mkdirSync(dirname(filePath), { recursive: true });
  // 2-space indent matches both ~/.cursor/mcp.json and ~/.claude.json
  // conventions in the wild.
  writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n');
  return { changed: true };
}

function shallowEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a as Record<string, unknown>).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!bk.includes(k)) return false;
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (typeof av === 'object' && av && typeof bv === 'object' && bv) {
      if (!shallowEqualJson(av, bv)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

// Avoid unused import warning when execSync is removed in tree-shaking.
void execSync;
