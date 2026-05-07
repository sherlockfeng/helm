import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Phase 48: Electron loads the bundled SPA via `file://` in production
  // (electron/main.ts → mainWindow.loadFile). Vite's default `base: '/'`
  // produces `<script src="/assets/...">`, which file:// resolves against
  // the filesystem root → 404 → white screen. `./` keeps references
  // relative to index.html so the same build works under both file:// and
  // any future http hosting.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 本地 dev：把 /api 转给主进程 HTTP server（端口由 config.server.port 决定，默认 17317）
      '/api': 'http://127.0.0.1:17317',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
