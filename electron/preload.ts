/**
 * Helm — Electron preload script.
 *
 * Renderer talks to the helm HTTP API at 127.0.0.1:<port>. The bundle is
 * loaded via `file://` in production, so a bare `/api/...` path won't
 * resolve to the right origin — see web/src/api/base-url.ts for the
 * fallback chain.
 *
 * Phase 50: main.ts pushes the live port via the file:// URL so the
 * preload can expose it as `window.helm.apiBase`. helm-design hotfix —
 * the param moved from `#apiBase=` to `?apiBase=` because the renderer
 * now uses HashRouter for client-side routing (BrowserRouter caused a
 * white screen on reload of any non-root path). The hash is owned by
 * the router; the search string is ours.
 */

import { contextBridge } from 'electron';

function readApiBaseFromSearch(): string | undefined {
  // location.search is always present at preload time (the URL has been
  // set). URLSearchParams parses standard ?key=value pairs.
  if (typeof location === 'undefined') return undefined;
  const params = new URLSearchParams(location.search);
  const value = params.get('apiBase');
  return value || undefined;
}

contextBridge.exposeInMainWorld('helm', {
  platform: process.platform,
  versions: process.versions,
  apiBase: readApiBaseFromSearch(),
});
