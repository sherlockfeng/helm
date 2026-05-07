/**
 * Unit tests for the renderer's API base-URL resolution (Phase 50).
 *
 * The renderer runs in three contexts that resolve `/api/...` differently:
 *   - vite dev server (http://localhost:5173) — proxy handles it
 *   - Electron production (file:///...) — NO same-origin, must point at
 *     http://127.0.0.1:17317 explicitly
 *   - future http hosting — same-origin again
 *
 * Phase 50 (#48 only fixed assets, not API calls). This suite locks in the
 * resolution logic so a regression — e.g. someone "simplifying" the function
 * back to `return ''` — fails CI before the white-screen / "Backend offline"
 * error reaches a user.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiUrl, resolveApiBase } from '../../../web/src/api/base-url.js';

const realWindow = (globalThis as { window?: unknown }).window;
const realLocation = (globalThis as { location?: unknown }).location;

function setEnvironment(opts: {
  protocol: 'file:' | 'http:' | 'https:';
  preloadApiBase?: string;
}): void {
  // jsdom-free: fake just the surface our module reads.
  (globalThis as Record<string, unknown>).window = {
    helm: opts.preloadApiBase !== undefined ? { apiBase: opts.preloadApiBase } : undefined,
  };
  (globalThis as Record<string, unknown>).location = { protocol: opts.protocol };
}

beforeEach(() => {
  // Each test sets its own environment; reset between to avoid leaks.
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).location;
});

afterEach(() => {
  // Restore whatever the test runner had — node has neither by default.
  if (realWindow !== undefined) (globalThis as Record<string, unknown>).window = realWindow;
  if (realLocation !== undefined) (globalThis as Record<string, unknown>).location = realLocation;
});

describe('resolveApiBase()', () => {
  it('file:// with no preload → defaults to http://127.0.0.1:17317', () => {
    setEnvironment({ protocol: 'file:' });
    expect(resolveApiBase()).toBe('http://127.0.0.1:17317');
  });

  it('file:// with preload-injected apiBase → uses the preload value', () => {
    setEnvironment({ protocol: 'file:', preloadApiBase: 'http://127.0.0.1:9999' });
    expect(resolveApiBase()).toBe('http://127.0.0.1:9999');
  });

  it('http:// (vite dev / future hosting) → empty string (same-origin)', () => {
    setEnvironment({ protocol: 'http:' });
    expect(resolveApiBase()).toBe('');
  });

  it('https:// → empty string (same-origin, e.g. remote helm hosting)', () => {
    setEnvironment({ protocol: 'https:' });
    expect(resolveApiBase()).toBe('');
  });

  it('preload value with trailing slash is stripped (avoid double slash on join)', () => {
    setEnvironment({ protocol: 'file:', preloadApiBase: 'http://127.0.0.1:17317/' });
    expect(resolveApiBase()).toBe('http://127.0.0.1:17317');
  });

  it('attack: window undefined (SSR-like) → empty string, no crash', () => {
    expect(resolveApiBase()).toBe('');
  });

  it('attack: empty preload string → falls through to file:// default', () => {
    setEnvironment({ protocol: 'file:', preloadApiBase: '' });
    expect(resolveApiBase()).toBe('http://127.0.0.1:17317');
  });

  it('attack: preload set under http:// is still honored (e.g. user proxying)', () => {
    setEnvironment({ protocol: 'http:', preloadApiBase: 'http://localhost:9000' });
    expect(resolveApiBase()).toBe('http://localhost:9000');
  });
});

describe('apiUrl()', () => {
  it('file:// prepends the resolved base to the path', () => {
    setEnvironment({ protocol: 'file:' });
    expect(apiUrl('/api/health')).toBe('http://127.0.0.1:17317/api/health');
  });

  it('http:// (same-origin) returns the bare path so the browser uses location.origin', () => {
    setEnvironment({ protocol: 'http:' });
    expect(apiUrl('/api/health')).toBe('/api/health');
  });

  it('preload override takes effect for both fetch and EventSource consumers', () => {
    setEnvironment({ protocol: 'file:', preloadApiBase: 'http://127.0.0.1:8080' });
    expect(apiUrl('/api/events')).toBe('http://127.0.0.1:8080/api/events');
  });
});
