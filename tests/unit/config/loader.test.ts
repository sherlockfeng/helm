import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHelmConfig } from '../../../src/config/loader.js';
import { HelmConfigSchema, DepscopeProviderConfigSchema } from '../../../src/config/schema.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-config-'));
  path = join(dir, 'config.json');
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('HelmConfigSchema defaults', () => {
  it('empty input fills in every default', () => {
    const c = HelmConfigSchema.parse({});
    expect(c.server.port).toBe(17_317);
    expect(c.approval.defaultTimeoutMs).toBe(24 * 60 * 60 * 1000);
    expect(c.approval.waitPollMs).toBe(10 * 60 * 1000);
    expect(c.lark.enabled).toBe(false);
    expect(c.knowledge.providers).toEqual([]);
  });

  it('attack: rejects unknown top-level keys (strict)', () => {
    expect(() => HelmConfigSchema.parse({ extra: 'nope' })).toThrow();
  });

  it('attack: invalid port number rejected', () => {
    expect(() => HelmConfigSchema.parse({ server: { port: 99_999 } })).toThrow();
    expect(() => HelmConfigSchema.parse({ server: { port: -1 } })).toThrow();
  });

  it('honors a fully populated config', () => {
    const c = HelmConfigSchema.parse({
      server: { port: 18_000 },
      approval: { defaultTimeoutMs: 1000, waitPollMs: 500 },
      lark: { enabled: true, cliCommand: '/opt/lark-cli' },
      knowledge: { providers: [{ id: 'depscope', enabled: true, config: { endpoint: 'http://x' } }] },
    });
    expect(c.server.port).toBe(18_000);
    expect(c.lark.cliCommand).toBe('/opt/lark-cli');
    expect(c.knowledge.providers).toHaveLength(1);
  });
});

describe('DepscopeProviderConfigSchema', () => {
  it('requires a valid URL', () => {
    expect(() => DepscopeProviderConfigSchema.parse({ endpoint: 'not a url' })).toThrow();
    expect(DepscopeProviderConfigSchema.parse({ endpoint: 'http://x.com' }).mappings).toEqual([]);
  });

  it('attack: rejects unknown keys', () => {
    expect(() => DepscopeProviderConfigSchema.parse({
      endpoint: 'http://x.com', extra: 1,
    })).toThrow();
  });
});

describe('loadHelmConfig', () => {
  it('returns defaults + loaded=false when file is missing', () => {
    const r = loadHelmConfig({ path });
    expect(r.loaded).toBe(false);
    expect(r.config.server.port).toBe(17_317);
  });

  it('loads + validates a real file', () => {
    writeFileSync(path, JSON.stringify({ server: { port: 18_000 } }));
    const r = loadHelmConfig({ path });
    expect(r.loaded).toBe(true);
    expect(r.config.server.port).toBe(18_000);
  });

  it('attack: malformed JSON falls back to defaults + onError(parse)', () => {
    writeFileSync(path, '{not json');
    const errors: Array<{ phase: string }> = [];
    const r = loadHelmConfig({ path, onError: (_err, ctx) => errors.push(ctx) });
    expect(r.loaded).toBe(false);
    expect(r.config.server.port).toBe(17_317);
    expect(errors[0]?.phase).toBe('parse');
  });

  it('attack: schema-violating config falls back + onError(validate)', () => {
    writeFileSync(path, JSON.stringify({ server: { port: 'not a number' } }));
    const errors: Array<{ phase: string }> = [];
    const r = loadHelmConfig({ path, onError: (_err, ctx) => errors.push(ctx) });
    expect(r.loaded).toBe(false);
    expect(errors[0]?.phase).toBe('validate');
  });

  it('attack: unknown extra keys at root level are caught (strict mode)', () => {
    writeFileSync(path, JSON.stringify({ extraField: 'hello' }));
    const errors: Array<{ phase: string }> = [];
    const r = loadHelmConfig({ path, onError: (_err, ctx) => errors.push(ctx) });
    expect(r.loaded).toBe(false);
    expect(errors[0]?.phase).toBe('validate');
  });
});
