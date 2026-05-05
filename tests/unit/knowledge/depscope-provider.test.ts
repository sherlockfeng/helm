/**
 * DepscopeProvider tests against a real local HTTP server with canned
 * responses. No mocking library — keeps the test surface honest about the
 * actual fetch behavior (timeouts, AbortController, JSON parsing).
 */

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DepscopeProvider } from '../../../src/knowledge/depscope-provider.js';
import type { KnowledgeContext } from '../../../src/knowledge/types.js';

interface FakeRoute {
  match: (req: http.IncomingMessage) => boolean;
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

let server: http.Server;
let baseUrl: string;
let routes: FakeRoute[] = [];
let requestLog: Array<{ method: string; url: string; auth?: string }> = [];

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      requestLog.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
      });
      const route = routes.find((r) => r.match(req));
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      route.handle(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  routes = [];
  requestLog = [];
  await startServer();
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const ctx = (cwd: string, filePath?: string): KnowledgeContext => ({
  hostSessionId: 's1',
  cwd,
  filePath,
});

describe('DepscopeProvider — construction', () => {
  it('attack: empty endpoint throws', () => {
    expect(() => new DepscopeProvider({ endpoint: '', mappings: [] })).toThrow(/endpoint/);
  });

  it('strips trailing slash from endpoint', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/health') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"ok":true}'); },
    });
    const p = new DepscopeProvider({ endpoint: `${baseUrl}/`, mappings: [] });
    expect((await p.healthcheck()).ok).toBe(true);
  });
});

describe('DepscopeProvider — canHandle', () => {
  it('true when cwd matches a mapping', () => {
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo/bar' }],
    });
    expect(p.canHandle(ctx('/proj/sub'))).toBe(true);
  });

  it('false when cwd does not match', () => {
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo/bar' }],
    });
    expect(p.canHandle(ctx('/other'))).toBe(false);
  });

  it('attack: empty mappings → never handles', () => {
    const p = new DepscopeProvider({ endpoint: baseUrl, mappings: [] });
    expect(p.canHandle(ctx('/proj'))).toBe(false);
  });
});

describe('DepscopeProvider — getSessionContext', () => {
  it('fetches markdown for the matched scmName', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (req, res) => {
        const u = new URL(req.url!, baseUrl);
        const scm = u.searchParams.get('scm');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ markdown: `## context for ${scm}` }));
      },
    });

    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo/bar' }],
    });
    const md = await p.getSessionContext(ctx('/proj/x'));
    expect(md).toBe('## context for foo/bar');
    expect(requestLog[0]?.url).toContain('scm=foo%2Fbar');
  });

  it('forwards filePath when provided', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"markdown":"x"}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo/bar' }],
    });
    await p.getSessionContext(ctx('/proj', '/proj/foo.ts'));
    expect(requestLog[0]?.url).toContain('filePath=%2Fproj%2Ffoo.ts');
  });

  it('attaches Bearer auth header when authToken is set', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"markdown":"x"}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      authToken: 'abc123',
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    await p.getSessionContext(ctx('/proj'));
    expect(requestLog[0]?.auth).toBe('Bearer abc123');
  });

  it('caches the markdown for cacheTtlMs', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"markdown":"v1"}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
      cacheTtlMs: 60_000,
    });
    expect(await p.getSessionContext(ctx('/proj'))).toBe('v1');
    expect(await p.getSessionContext(ctx('/proj'))).toBe('v1');
    // Only one HTTP call should have been made
    expect(requestLog.filter((r) => r.url.startsWith('/api/v1/sessions'))).toHaveLength(1);
  });

  it('clearCache() forces a fresh fetch', async () => {
    let counter = 0;
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end(`{"markdown":"v${++counter}"}`); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    expect(await p.getSessionContext(ctx('/proj'))).toBe('v1');
    p.clearCache();
    expect(await p.getSessionContext(ctx('/proj'))).toBe('v2');
  });

  it('does NOT cache failures (next call retries)', async () => {
    let firstCall = true;
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => {
        if (firstCall) { firstCall = false; res.writeHead(503); res.end('{}'); }
        else { res.writeHead(200); res.end('{"markdown":"now ok"}'); }
      },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    expect(await p.getSessionContext(ctx('/proj'))).toBeNull();
    expect(await p.getSessionContext(ctx('/proj'))).toBe('now ok');
  });

  it('returns null when no mapping matches', async () => {
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    expect(await p.getSessionContext(ctx('/elsewhere'))).toBeNull();
    expect(requestLog).toHaveLength(0);
  });

  it('attack: 404 returns null + warning', async () => {
    const warnings: string[] = [];
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => { res.writeHead(404); res.end('{}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
      onWarning: (msg) => warnings.push(msg),
    });
    expect(await p.getSessionContext(ctx('/proj'))).toBeNull();
    expect(warnings).toContain('non_2xx');
  });

  it('attack: malformed JSON body returns null + parse warning', async () => {
    const warnings: string[] = [];
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('not json'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
      onWarning: (msg) => warnings.push(msg),
    });
    expect(await p.getSessionContext(ctx('/proj'))).toBeNull();
    expect(warnings).toContain('json_parse_error');
  });

  it('attack: missing markdown field returns null', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    expect(await p.getSessionContext(ctx('/proj'))).toBeNull();
  });

  it('attack: server hang triggers timeout (signal abort)', async () => {
    const warnings: string[] = [];
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: () => { /* never respond */ },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
      requestTimeoutMs: 50,
      onWarning: (msg) => warnings.push(msg),
    });
    expect(await p.getSessionContext(ctx('/proj'))).toBeNull();
    expect(warnings).toContain('timeout');
  });

  it('attack: longest-prefix wins when mappings overlap', async () => {
    const seen: string[] = [];
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/sessions') ?? false,
      handle: (req, res) => {
        const scm = new URL(req.url!, baseUrl).searchParams.get('scm');
        seen.push(scm ?? '');
        res.writeHead(200); res.end('{"markdown":"x"}');
      },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [
        { cwdPrefix: '/proj', scmName: 'broad' },
        { cwdPrefix: '/proj/sub', scmName: 'narrow' },
      ],
    });
    await p.getSessionContext(ctx('/proj/sub/file'));
    expect(seen).toEqual(['narrow']);
  });
});

describe('DepscopeProvider — search', () => {
  it('returns snippets tagged with provider id', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/search') ?? false,
      handle: (_, res) => {
        res.writeHead(200);
        res.end(JSON.stringify({
          snippets: [
            { title: 't1', body: 'b1', score: 0.9, citation: 'c1' },
            { title: 't2', body: 'b2' },
          ],
        }));
      },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    const results = await p.search('hello', ctx('/proj'));
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ source: 'depscope', title: 't1', score: 0.9 });
    expect(results[1]?.score).toBeUndefined();
  });

  it('scopes search by mapping when ctx is provided', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/search') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"snippets":[]}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    await p.search('q', ctx('/proj'));
    expect(requestLog[0]?.url).toContain('scm=foo');
  });

  it('drops scm parameter when ctx has no matching mapping', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/search') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"snippets":[]}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    await p.search('q', ctx('/elsewhere'));
    expect(requestLog[0]?.url).not.toContain('scm=');
  });

  it('attack: empty query returns [] without hitting the endpoint', async () => {
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    expect(await p.search('   ')).toEqual([]);
    expect(requestLog).toHaveLength(0);
  });

  it('attack: snippets field missing → returns []', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/search') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    expect(await p.search('q')).toEqual([]);
  });

  it('attack: malformed snippet entries are filtered out', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/search') ?? false,
      handle: (_, res) => {
        res.writeHead(200);
        res.end(JSON.stringify({
          snippets: [null, 42, 'string', { title: 'ok', body: 'b' }],
        }));
      },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    const r = await p.search('q');
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe('ok');
  });

  it('attack: 500 returns []', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/search') ?? false,
      handle: (_, res) => { res.writeHead(500); res.end('{}'); },
    });
    const p = new DepscopeProvider({
      endpoint: baseUrl,
      mappings: [{ cwdPrefix: '/proj', scmName: 'foo' }],
    });
    expect(await p.search('q')).toEqual([]);
  });
});

describe('DepscopeProvider — healthcheck', () => {
  it('reports ok=true when endpoint says so', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/health') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"ok":true}'); },
    });
    const p = new DepscopeProvider({ endpoint: baseUrl, mappings: [] });
    expect(await p.healthcheck()).toEqual({ ok: true });
  });

  it('reports ok=false with reason when endpoint reports unhealthy', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/health') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('{"ok":false,"reason":"db down"}'); },
    });
    const p = new DepscopeProvider({ endpoint: baseUrl, mappings: [] });
    expect(await p.healthcheck()).toEqual({ ok: false, reason: 'db down' });
  });

  it('attack: endpoint unreachable → ok=false unreachable', async () => {
    // Stop server immediately; fetch will fail with ECONNREFUSED
    await new Promise<void>((r) => server.close(() => r()));
    const p = new DepscopeProvider({ endpoint: baseUrl, mappings: [] });
    const r = await p.healthcheck();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreachable');
    // Re-start a fresh server so the afterEach close() doesn't error
    await startServer();
  });

  it('attack: endpoint returns invalid JSON → ok=false with parse reason', async () => {
    routes.push({
      match: (req) => req.url?.startsWith('/api/v1/health') ?? false,
      handle: (_, res) => { res.writeHead(200); res.end('not json'); },
    });
    const p = new DepscopeProvider({ endpoint: baseUrl, mappings: [] });
    const r = await p.healthcheck();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parse/i);
  });
});
