/**
 * `helm setup-mcp` — register helm's MCP server with Claude Code / Cursor
 * (Phase 60a).
 *
 * The user's intended flow is "open my CLI, chat about something, say 'save
 * this as a helm role' → CLI calls helm MCP train_role → done". For that
 * to work, the CLI has to know about helm's MCP. This command is what the
 * user runs once to set it up.
 *
 * Tests pin two contracts:
 *   1. Cursor path edits ~/.cursor/mcp.json idempotently and preserves
 *      existing entries (the user might have other MCP servers configured).
 *   2. Claude path delegates to `claude mcp add --scope user --transport sse`
 *      and short-circuits when an entry already exists.
 *
 * The Claude path uses a stubbed `exec` so tests don't need a real `claude`
 * binary on PATH (CI machines don't).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupMcp, HELM_MCP_URL_DEFAULT } from '../../../src/cli/setup-mcp.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'helm-setup-mcp-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('setup-mcp cursor', () => {
  it('creates ~/.cursor/mcp.json with helm when the file is missing', () => {
    const r = setupMcp('cursor', { homeDir: home });
    expect(r.changed).toBe(true);
    const file = join(home, '.cursor', 'mcp.json');
    expect(existsSync(file)).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.mcpServers.helm).toEqual({ type: 'sse', url: HELM_MCP_URL_DEFAULT });
  });

  it('preserves existing MCP entries when adding helm', () => {
    const file = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        Playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
      },
      // Top-level keys outside mcpServers must survive too.
      somethingElse: 42,
    }));

    const r = setupMcp('cursor', { homeDir: home });
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.mcpServers.Playwright.command).toBe('npx');
    expect(json.mcpServers.helm).toEqual({ type: 'sse', url: HELM_MCP_URL_DEFAULT });
    expect(json.somethingElse).toBe(42);
  });

  it('idempotent: re-running with the same URL returns changed=false and does not rewrite the file', () => {
    setupMcp('cursor', { homeDir: home });
    const file = join(home, '.cursor', 'mcp.json');
    const firstMtime = readFileSync(file, 'utf8');

    const r2 = setupMcp('cursor', { homeDir: home });
    expect(r2.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(firstMtime);
  });

  it('updates the entry when the URL changes', () => {
    setupMcp('cursor', { homeDir: home });
    const r2 = setupMcp('cursor', { homeDir: home, url: 'http://127.0.0.1:9999/mcp/sse' });
    expect(r2.changed).toBe(true);
    const file = join(home, '.cursor', 'mcp.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.mcpServers.helm).toEqual({ type: 'sse', url: 'http://127.0.0.1:9999/mcp/sse' });
  });

  it('attack: refuses to overwrite a corrupt JSON file (no silent data loss)', () => {
    const file = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(file, '{not json');
    expect(() => setupMcp('cursor', { homeDir: home })).toThrow(/not valid JSON/);
  });

  it('attack: empty existing file is treated as fresh-create, not a parse error', () => {
    const file = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(file, '');
    expect(() => setupMcp('cursor', { homeDir: home })).not.toThrow();
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.mcpServers.helm).toEqual({ type: 'sse', url: HELM_MCP_URL_DEFAULT });
  });

  // Phase 75 — Cursor 1.x tightened the SSE schema. An entry with `url` but
  // no `type` triggers a misleading "Server 'mcpServers' must have either
  // command or url" banner. Pin the `type: 'sse'` field so future edits
  // can't drop it silently.
  it('Phase 75: writes `type: "sse"` explicitly so Cursor 1.x parser is happy', () => {
    setupMcp('cursor', { homeDir: home });
    const file = join(home, '.cursor', 'mcp.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.mcpServers.helm.type).toBe('sse');
    expect(json.mcpServers.helm.url).toBe(HELM_MCP_URL_DEFAULT);
  });

  it('Phase 75: refuses to write when the file has duplicate top-level `mcpServers` keys', () => {
    // Real-world failure mode: Cursor's Settings UI or a third-party tool
    // appended a second `"mcpServers"` block instead of merging into the
    // existing one. JSON.parse silently drops the first block — including
    // helm — which produces the confusing "Server 'mcpServers'" parser
    // error in Cursor's UI. Refuse to write so the user notices.
    const file = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(file, [
      '{',
      '  "mcpServers": {',
      '    "alpha": { "command": "x" }',
      '  },',
      '  "mcpServers": {',
      '    "beta": { "command": "y" }',
      '  }',
      '}',
    ].join('\n'));

    expect(() => setupMcp('cursor', { homeDir: home })).toThrow(/duplicate.*mcpServers|merge both blocks/i);
  });

  it('Phase 75: nested "mcpServers" string inside another key is NOT counted as a duplicate', () => {
    const file = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(file, [
      '{',
      '  "mcpServers": {',
      '    "alpha": { "command": "echo mcpServers" }',
      '  },',
      '  "note": "remember to back up mcpServers"',
      '}',
    ].join('\n'));
    // Should add helm fine — no actual duplicate.
    expect(() => setupMcp('cursor', { homeDir: home })).not.toThrow();
  });

  it('Phase 75: migrates a pre-Phase-75 url-only entry to include type: sse', () => {
    // User who ran an older helm setup-mcp ended up with `{ url: ... }`
    // sans type. Re-running setup-mcp should patch the entry to add the
    // type field (changed=true) instead of being a no-op.
    const file = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(file, JSON.stringify({
      mcpServers: { helm: { url: HELM_MCP_URL_DEFAULT } },
    }));

    const r = setupMcp('cursor', { homeDir: home });
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.mcpServers.helm).toEqual({ type: 'sse', url: HELM_MCP_URL_DEFAULT });
  });
});

describe('setup-mcp claude', () => {
  it('shells out to `claude mcp add --scope user --transport sse helm <url>`', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const exec = (cmd: string, args: readonly string[]): string => {
      calls.push({ cmd, args });
      if (args[0] === '--version') return 'claude 1.0.0';
      if (args[0] === 'mcp' && args[1] === 'list') return 'No MCP servers configured.';
      return '';
    };

    const r = setupMcp('claude', { homeDir: home, exec });
    expect(r.changed).toBe(true);
    // The third call must be the `mcp add` invocation.
    const addCall = calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall!.args).toEqual([
      'mcp', 'add', '--scope', 'user', '--transport', 'sse', 'helm',
      HELM_MCP_URL_DEFAULT,
    ]);
  });

  it('idempotent: skips the add when `claude mcp list` already shows helm', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const exec = (cmd: string, args: readonly string[]): string => {
      calls.push({ cmd, args });
      if (args[0] === '--version') return 'claude 1.0.0';
      if (args[0] === 'mcp' && args[1] === 'list') {
        return 'helm: http://127.0.0.1:17317/mcp/sse (sse) - ✓ Connected';
      }
      throw new Error('should not have been called');
    };

    const r = setupMcp('claude', { homeDir: home, exec });
    expect(r.changed).toBe(false);
    expect(calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'add')).toBeUndefined();
  });

  it('attack: claude CLI not on PATH → returns a friendly message, does not throw', () => {
    const exec = (): string => { throw new Error('ENOENT'); };
    const r = setupMcp('claude', { homeDir: home, exec });
    expect(r.changed).toBe(false);
    expect(r.message).toMatch(/Claude Code CLI not found/i);
  });

  it('attack: `claude mcp list` failing is treated as "not yet configured" (continues to add)', () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const exec = (_cmd: string, args: readonly string[]): string => {
      calls.push({ args });
      if (args[0] === '--version') return 'claude 1.0.0';
      if (args[0] === 'mcp' && args[1] === 'list') throw new Error('list failed');
      return '';
    };
    const r = setupMcp('claude', { homeDir: home, exec });
    expect(r.changed).toBe(true);
    expect(calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'add')).toBeDefined();
  });

  it('claudeFallbackToFile mode writes the entry to ~/.claude.json (test path)', () => {
    const r = setupMcp('claude', { homeDir: home, claudeFallbackToFile: true });
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(json.mcpServers.helm).toEqual({ type: 'sse', url: HELM_MCP_URL_DEFAULT });
  });
});
