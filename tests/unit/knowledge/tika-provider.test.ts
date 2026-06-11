/**
 * Unit tests for TikaProvider (MCP-stdio bridge to the Tika knowledge
 * platform). The real transport spawns `npx @tiktok-mcp/tika`; tests
 * inject a fake connection via the `connectFactory` seam — no
 * subprocess, no network.
 */

import { describe, expect, it, vi } from 'vitest';
import { TikaProvider, type TikaMcpConnection } from '../../../src/knowledge/tika-provider.js';

function fakeConnection(overrides: Partial<TikaMcpConnection> = {}): TikaMcpConnection & {
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  closed: () => boolean;
} {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let closed = false;
  const conn = {
    listTools: async () => ({ tools: [{ name: 'tika' }, { name: 'agent_chat' }] }),
    callTool: async (input: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(input);
      return { content: [{ type: 'text', text: 'OG v5 已有结论：schema 不匹配时回退 v4。' }] };
    },
    close: async () => { closed = true; },
    ...overrides,
  };
  return Object.assign(conn, { calls, closed: () => closed });
}

function makeProvider(conn: TikaMcpConnection, opts: Partial<ConstructorParameters<typeof TikaProvider>[0]> = {}): TikaProvider {
  return new TikaProvider({
    tikaEnv: 'office', spaceId: 'space-1', serviceKey: 'sk-1',
    connectFactory: async () => conn,
    ...opts,
  });
}

describe('TikaProvider', () => {
  it('personal-SSO mode: constructs without spaceId / serviceKey', () => {
    // SSO mode passes only TIKA_ENV; the Tika MCP server pops browser
    // authorization on first call. No constructor guard.
    expect(() => new TikaProvider({ tikaEnv: 'office' })).not.toThrow();
  });

  it('search calls the auto-detected tika tool with userQuery and maps text to one snippet', async () => {
    const conn = fakeConnection();
    const p = makeProvider(conn);
    const snippets = await p.search('OG v5 schema');
    expect(conn.calls).toEqual([{ name: 'tika', arguments: { userQuery: 'OG v5 schema' } }]);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({
      source: 'tika',
      body: expect.stringContaining('OG v5 已有结论'),
    });
  });

  it('honors an explicit toolName override without listing tools', async () => {
    const listTools = vi.fn();
    const conn = fakeConnection({ listTools });
    const p = makeProvider(conn, { toolName: 'custom_search' });
    await p.search('q');
    expect(listTools).not.toHaveBeenCalled();
    expect(conn.calls[0]?.name).toBe('custom_search');
  });

  it('reuses one connection across queries (single connect)', async () => {
    const conn = fakeConnection();
    const factory = vi.fn(async () => conn);
    const p = new TikaProvider({
      tikaEnv: 'office', spaceId: 's', serviceKey: 'k', connectFactory: factory,
    });
    await p.search('one');
    await p.search('two');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('empty / whitespace query short-circuits to [] without connecting', async () => {
    const factory = vi.fn();
    const p = new TikaProvider({
      tikaEnv: 'office', spaceId: 's', serviceKey: 'k', connectFactory: factory,
    });
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
    const p = new TikaProvider({
      tikaEnv: 'office', spaceId: 's', serviceKey: 'k', connectFactory: factory,
    });
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
    expect(await p.healthcheck()).toEqual({ ok: true, reason: 'connected; tool=tika' });

    const failing = new TikaProvider({
      tikaEnv: 'office', spaceId: 's', serviceKey: 'k',
      connectFactory: async () => { throw new Error('npx not found'); },
    });
    const health = await failing.healthcheck();
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/npx not found/);
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
