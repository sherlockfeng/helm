/**
 * Plugin loader — Phase 79.
 *
 * Pins:
 *   - missing plugin dir → registerFailure (boot continues)
 *   - bad export shape → registerFailure
 *   - unsupported apiVersion → registerFailure
 *   - id mismatch (dirname vs plugin.id) → registerFailure
 *   - init throws → registerFailure
 *   - scheme collision → second plugin fails, first remains
 *   - happy path → registerOk + scheme dispatch works
 *   - one failure does NOT stop loading of subsequent plugins
 */

import { describe, expect, it } from 'vitest';
import {
  loadPlugins,
  PLUGIN_API_VERSION_CURRENT,
  PluginRegistry,
  type StoragePlugin,
} from '../../../src/plugins/index.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeOk(overrides: Partial<StoragePlugin> = {}): StoragePlugin {
  const base: StoragePlugin = {
    id: 'helm-storage-fake',
    scheme: 'fake',
    version: '0.0.1',
    apiVersion: PLUGIN_API_VERSION_CURRENT,
    init() {},
    download: async () => Buffer.from(''),
    upload: async () => ({ etag: 'e' }),
    headEtag: async () => 'e',
  };
  return { ...base, ...overrides };
}

describe('loadPlugins', () => {
  it('missing plugin dir → failure record, registry still works', async () => {
    const registry = new PluginRegistry();
    await loadPlugins(registry, {
      plugins: { enabled: ['helm-storage-missing'] },
      storage: {},
      logger: noopLogger,
      pluginsDir: '/tmp/definitely-not-a-helm-plugins-dir-xyz',
    });
    const list = registry.listAll();
    expect(list.length).toBe(1);
    expect(list[0]?.ok).toBe(false);
    if (!list[0]?.ok) expect(list[0]?.reason).toContain('not found');
  });

  it('init throws → failure record; subsequent plugins still load', async () => {
    const registry = new PluginRegistry();
    let secondInitCalled = false;
    await loadPlugins(registry, {
      plugins: { enabled: ['broken', 'good'] },
      storage: {},
      logger: noopLogger,
      pluginsDir: '/anywhere',
      requireOverride: (p) => {
        if (p.endsWith('broken')) {
          return {
            default: makeOk({
              id: 'broken',
              scheme: 'broken',
              init() { throw new Error('config missing'); },
            }),
          };
        }
        return {
          default: makeOk({
            id: 'good',
            scheme: 'good',
            init() { secondInitCalled = true; },
          }),
        };
      },
    });
    expect(secondInitCalled).toBe(true);
    const goodEntry = registry.listAll().find((p) => p.ok && p.plugin.id === 'good');
    const brokenEntry = registry.listAll().find((p) => !p.ok && p.id === 'broken');
    expect(goodEntry?.ok).toBe(true);
    expect(brokenEntry?.ok).toBe(false);
  });

  it('unsupported apiVersion → failure record', async () => {
    const registry = new PluginRegistry();
    await loadPlugins(registry, {
      plugins: { enabled: ['fake'] },
      storage: {},
      logger: noopLogger,
      requireOverride: () => ({
        default: makeOk({ id: 'fake', apiVersion: 999 }),
      }),
    });
    const entry = registry.listAll()[0]!;
    expect(entry.ok).toBe(false);
    if (!entry.ok) expect(entry.reason).toContain('unsupported');
  });

  it('id mismatch (dirname vs self.id) → failure record', async () => {
    const registry = new PluginRegistry();
    await loadPlugins(registry, {
      plugins: { enabled: ['expected-id'] },
      storage: {},
      logger: noopLogger,
      requireOverride: () => ({
        default: makeOk({ id: 'something-else' }),
      }),
    });
    const entry = registry.listAll()[0]!;
    expect(entry.ok).toBe(false);
    if (!entry.ok) expect(entry.reason).toContain('does not match');
  });

  it('bad export (missing fields) → failure record, not crash', async () => {
    const registry = new PluginRegistry();
    await loadPlugins(registry, {
      plugins: { enabled: ['bad-shape'] },
      storage: {},
      logger: noopLogger,
      requireOverride: () => ({ default: { id: 'bad-shape' } }), // missing scheme / init / …
    });
    const entry = registry.listAll()[0]!;
    expect(entry.ok).toBe(false);
    if (!entry.ok) expect(entry.reason).toContain('did not export');
  });

  it('happy path: registers ok + scheme lookup works + init received config', async () => {
    const registry = new PluginRegistry();
    let initSawConfig: unknown = undefined;
    await loadPlugins(registry, {
      plugins: { enabled: ['demo'] },
      storage: { demo: { hello: 'world' } },
      logger: noopLogger,
      requireOverride: () => ({
        default: makeOk({
          id: 'demo',
          scheme: 'demo',
          init({ config }) { initSawConfig = config; },
        }),
      }),
    });
    expect(registry.getByScheme('demo')).toBeDefined();
    expect(initSawConfig).toEqual({ hello: 'world' });
  });

  it('module.exports = {...} (no .default) works too', async () => {
    const registry = new PluginRegistry();
    await loadPlugins(registry, {
      plugins: { enabled: ['cjs'] },
      storage: {},
      logger: noopLogger,
      requireOverride: () => makeOk({ id: 'cjs', scheme: 'cjs' }),
    });
    expect(registry.getByScheme('cjs')).toBeDefined();
  });
});

describe('loadPlugins — id validation (reviewer should-fix)', () => {
  it.each([
    '../escape',
    '../../usr/local/lib',
    '.hidden',
    'foo/bar',
    'foo\\bar',
    '.',
    '..',
  ])('rejects path-traversal-shaped id %j', async (badId) => {
    const registry = new PluginRegistry();
    await loadPlugins(registry, {
      plugins: { enabled: [badId] },
      storage: {},
      logger: noopLogger,
      requireOverride: () => ({ default: makeOk({ id: badId }) }),
    });
    const entry = registry.listAll()[0]!;
    expect(entry.ok).toBe(false);
    if (!entry.ok) expect(entry.reason).toContain('invalid plugin id');
  });
});

describe('PluginRegistry scheme collision', () => {
  it('two plugins claiming the same scheme → second registers as failure', async () => {
    const registry = new PluginRegistry();
    await loadPlugins(registry, {
      plugins: { enabled: ['first', 'second'] },
      storage: {},
      logger: noopLogger,
      requireOverride: (p) => ({
        default: makeOk({
          id: p.endsWith('first') ? 'first' : 'second',
          scheme: 'shared', // both claim the same!
        }),
      }),
    });
    const live = registry.listLive();
    expect(live.length).toBe(1);
    expect(live[0]?.id).toBe('first');
    const failed = registry.listAll().filter((p) => !p.ok);
    expect(failed.length).toBe(1);
    expect((failed[0] as { id: string }).id).toBe('second');
  });
});
