/**
 * Resolve the helm HTTP API origin at runtime.
 *
 * Three contexts the renderer runs in:
 *   1. Vite dev server (`http://localhost:5173`) — `/api` is proxied to
 *      `http://127.0.0.1:17317` by vite, so an empty base + relative path
 *      Just Works.
 *   2. Bundled Electron prod (`file:///…/web/dist/index.html`) — relative
 *      `/api/...` paths resolve against `file:///` and 404. We must point
 *      explicitly at `http://127.0.0.1:<port>`.
 *   3. Future http hosting (e.g. shipping helm as a remote service). Same-
 *      origin same as case 1.
 *
 * The Electron preload exposes `window.helm.apiBase` when it knows the live
 * port; otherwise we fall back to the documented default (17317). Users who
 * change `config.server.port` and don't get the preload-injected value will
 * see "Backend offline" — surfaced loudly so they notice rather than the
 * renderer silently spinning.
 */

const DEFAULT_HELM_PORT = 17317;

declare global {
  interface Window {
    helm?: {
      platform?: string;
      versions?: Record<string, string>;
      /** Phase 50: live API origin injected by the Electron preload. */
      apiBase?: string;
    };
  }
}

export function resolveApiBase(): string {
  // Build-time `import.meta.env.PROD` could also work, but a runtime check
  // is more honest about the actual environment we're in (e.g. unit tests
  // running the bundle under jsdom).
  if (typeof window === 'undefined') return '';

  // Preload has the canonical port — prefer it.
  const fromPreload = window.helm?.apiBase;
  if (typeof fromPreload === 'string' && fromPreload.length > 0) {
    return fromPreload.replace(/\/$/, '');
  }

  // Same-origin works for http(s):// (vite dev or remote hosting).
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    return '';
  }

  // file:// fallback — the bundled Electron production case before the
  // preload caught up. Default port matches `config.server.port`'s default.
  return `http://127.0.0.1:${DEFAULT_HELM_PORT}`;
}

/** Join the resolved base with the given relative path. */
export function apiUrl(path: string): string {
  const base = resolveApiBase();
  if (!base) return path;
  // Path always starts with '/'; the base never trails one.
  return base + path;
}
