import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHelmConfig, saveHelmConfig } from '../../../src/config/loader.js';
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
    // B4: doc-first defaults to enforce=true (matches §12.3)
    expect(c.docFirst.enforce).toBe(true);
  });

  it('docFirst.enforce can be turned off via config', () => {
    const c = HelmConfigSchema.parse({ docFirst: { enforce: false } });
    expect(c.docFirst.enforce).toBe(false);
  });

  it('attack: docFirst rejects unknown nested keys', () => {
    expect(() => HelmConfigSchema.parse({ docFirst: { extra: true } })).toThrow();
  });

  it('attack: rejects unknown top-level keys (strict)', () => {
    expect(() => HelmConfigSchema.parse({ extra: 'nope' })).toThrow();
  });

  it('Phase 24: cursor defaults', () => {
    const c = HelmConfigSchema.parse({});
    expect(c.cursor.apiKey).toBeUndefined();
    expect(c.cursor.model).toBe('auto');
    expect(c.cursor.mode).toBe('local');
  });

  it('Phase 24: cursor accepts overrides', () => {
    const c = HelmConfigSchema.parse({
      cursor: { apiKey: 'sk-cur-x', model: 'gpt-5', mode: 'cloud' },
    });
    expect(c.cursor.apiKey).toBe('sk-cur-x');
    expect(c.cursor.model).toBe('gpt-5');
    expect(c.cursor.mode).toBe('cloud');
  });

  it('Phase 24: attack — cursor.mode must be local|cloud', () => {
    expect(() => HelmConfigSchema.parse({ cursor: { mode: 'desktop' } })).toThrow();
  });

  it('Phase 24: attack — cursor rejects unknown nested keys (strict)', () => {
    expect(() => HelmConfigSchema.parse({ cursor: { extra: 1 } })).toThrow();
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

describe('saveHelmConfig', () => {
  it('writes a validated config to disk and returns the parsed value', () => {
    const saved = saveHelmConfig({ server: { port: 18000 } }, { path });
    expect(existsSync(path)).toBe(true);
    expect(saved.server.port).toBe(18000);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { server: { port: number } };
    expect(onDisk.server.port).toBe(18000);
  });

  it('fills in defaults for unspecified fields', () => {
    const saved = saveHelmConfig({}, { path });
    expect(saved.server.port).toBe(17317);
    expect(saved.lark.enabled).toBe(false);
  });

  it('attack: invalid input throws (config not written)', () => {
    expect(() => saveHelmConfig({ server: { port: 'nope' } }, { path })).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('attack: unknown top-level key rejected (strict)', () => {
    expect(() => saveHelmConfig({ extra: 'x' }, { path })).toThrow();
  });

  it('atomically replaces an existing file', () => {
    saveHelmConfig({ server: { port: 17317 } }, { path });
    saveHelmConfig({ server: { port: 19999 } }, { path });
    expect(JSON.parse(readFileSync(path, 'utf8')).server.port).toBe(19999);
    // No leftover .tmp file
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
