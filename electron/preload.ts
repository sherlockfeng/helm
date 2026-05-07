/**
 * Helm — Electron preload script.
 *
 * Renderer talks to the helm HTTP API at 127.0.0.1:<port>. The bundle is
 * loaded via `file://` in production, so a bare `/api/...` path won't
 * resolve to the right origin — see web/src/api/base-url.ts for the
 * fallback chain.
 *
 * Phase 50: main.ts pushes the live port via the file:// URL hash before
 * loadFile fires (`#apiBase=http://127.0.0.1:17317`); this preload reads
 * that and exposes it as `window.helm.apiBase` so the renderer doesn't
 * have to assume the default port.
 */

import { contextBridge } from 'electron';

function readApiBaseFromHash(): string | undefined {
  // location.hash is always present at preload time (the URL has been set).
  const hash = typeof location !== 'undefined' ? location.hash : '';
  if (!hash) return undefined;
  const match = hash.match(/(?:^#|&)apiBase=([^&]+)/);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

contextBridge.exposeInMainWorld('helm', {
  platform: process.platform,
  versions: process.versions,
  apiBase: readApiBaseFromHash(),
});
