/**
 * Unit tests for McpStdioProvider — the generic config-driven bridge to
 * any MCP stdio knowledge server. The real transport spawns the
 * configured command; tests inject a fake connection via the
 * `connectFactory` seam — no subprocess, no network.
 */

import { describe, expect, it, vi } from 'vitest';
import { McpStdioProvider, type McpBridgeConnection } from '../../../src/knowledge/mcp-provider.js';

function fakeConnection(overrides: Partial<McpBridgeConnection> = {}): McpBridgeConnection & {
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  closed: () => boolean;
} {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let closed = false;
  const conn = {
    listTools: async () => ({ tools: [{ name: 'kb' }, { name: 'agent_chat' }] }),
    callTool: async (input: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(input);
      return { content: [{ type: 'text', text: '已有结论：schema 不匹配时回退 v4。' }] };
    },
    close: async () => { closed = true; },
    ...overrides,
  };
  return Object.assign(conn, { calls, closed: () => closed });
}

function makeProvider(conn: McpBridgeConnection, opts: Partial<ConstructorParameters<typeof McpStdioProvider>[0]> = {}): McpStdioProvider {
  return new McpStdioProvider({
    id: 'kb', command: 'npx',
    connectFactory: async () => conn,
    ...opts,
  });
}

describe('McpStdioProvider', () => {
  it('requires id + command', () => {
    expect(() => new McpStdioProvider({ id: '', command: 'npx' })).toThrow(/id \+ command/);
    expect(() => new McpStdioProvider({ id: 'kb', command: '' })).toThrow(/id \+ command/);
  });

  it('search calls the id-matching tool with the default userQuery param', async () => {
    const conn = fakeConnection();
    const p = makeProvider(conn);
    const snippets = await p.search('OG v5 schema');
    expect(conn.calls).toEqual([{ name: 'kb', arguments: { userQuery: 'OG v5 schema' } }]);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({
      source: 'kb',
      body: expect.stringContaining('已有结论'),
    });
  });

  it('falls back to a search-named tool when no tool matches the id', async () => {
    const conn = fakeConnection({
      listTools: async () => ({ tools: [{ name: 'do_other' }, { name: 'kb_search' }] }),
    });
    const p = makeProvider(conn);
    await p.search('q');
    expect(conn.calls[0]?.name).toBe('kb_search');
  });

  it('honors an explicit toolName + queryParam without listing tools', async () => {
    const listTools = vi.fn();
    const conn = fakeConnection({ listTools });
    const p = makeProvider(conn, { toolName: 'custom_search', queryParam: 'q' });
    await p.search('hello');
    expect(listTools).not.toHaveBeenCalled();
    expect(conn.calls[0]).toEqual({ name: 'custom_search', arguments: { q: 'hello' } });
  });

  it('reuses one connection across queries (single connect)', async () => {
    const conn = fakeConnection();
    const factory = vi.fn(async () => conn);
    const p = new McpStdioProvider({ id: 'kb', command: 'npx', connectFactory: factory });
    await p.search('one');
    await p.search('two');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('empty / whitespace query short-circuits to [] without connecting', async () => {
    const factory = vi.fn();
    const p = new McpStdioProvider({ id: 'kb', command: 'npx', connectFactory: factory });
    expect(await p.search('   ')).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('tool errors return [] (provider boundary never throws)', async () => {
    const conn = fakeConnection({
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
    });
    const p = makeProvider(conn);
    expect(await p.search('q')).toEqual([]);
  });

  it('transport failure returns [], drops the connection, and reconnects next call', async () => {
    let attempt = 0;
    const good = fakeConnection();
    const bad = fakeConnection({
      callTool: async () => { throw new Error('broken pipe'); },
    });
    const factory = vi.fn(async () => (attempt++ === 0 ? bad : good));
    const p = new McpStdioProvider({ id: 'kb', command: 'npx', connectFactory: factory });
    expect(await p.search('q1')).toEqual([]);
    expect(bad.closed()).toBe(true);
    const second = await p.search('q2');
    expect(second).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('search times out and degrades to []', async () => {
    const conn = fakeConnection({
      callTool: () => new Promise(() => { /* hangs forever */ }),
    });
    const p = makeProvider(conn, { requestTimeoutMs: 30 });
    expect(await p.search('slow')).toEqual([]);
  });

  it('healthcheck reports ok with the resolved tool, unhealthy on connect failure', async () => {
    const p = makeProvider(fakeConnection());
    expect(await p.healthcheck()).toEqual({ ok: true, reason: 'connected; tool=kb' });

    const failing = new McpStdioProvider({
      id: 'kb', command: 'npx',
      connectFactory: async () => { throw new Error('command not found'); },
    });
    const health = await failing.healthcheck();
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/command not found/);
  });

  it('canHandle is unconditional and getSessionContext is null (query-driven only)', async () => {
    const p = makeProvider(fakeConnection());
    expect(p.canHandle({ hostSessionId: 'h', cwd: '/anywhere' })).toBe(true);
    expect(await p.getSessionContext({ hostSessionId: 'h', cwd: '/x' })).toBeNull();
  });

  it('dispose closes the connection and is idempotent', async () => {
    const conn = fakeConnection();
    const p = makeProvider(conn);
    await p.search('warm up');
    await p.dispose();
    expect(conn.closed()).toBe(true);
    await p.dispose(); // second call must not throw
  });
});
