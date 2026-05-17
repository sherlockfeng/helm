import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Phase 48: Electron loads the bundled SPA via `file://` in production
  // (electron/main.ts → mainWindow.loadFile). Vite's default `base: '/'`
  // produces `<script src="/assets/...">`, which file:// resolves against
  // the filesystem root → 404 → white screen. `./` keeps references
  // relative to index.html so the same build works under both file:// and
  // any future http hosting.
  base: './',
  // Phase 79 follow-up: Tailwind v4 via the official Vite plugin. CSS
  // entry (`src/styles/app.css`) imports `tailwindcss/utilities` and
  // declares the theme tokens that map to helm's existing CSS vars.
  // Tailwind's preflight is intentionally NOT imported — helm has its
  // own form-control / button resets and the preflight would clash.
  // New code uses utility classes; existing code keeps named .helm-*
  // classes until migrated component-by-component.
  plugins: [tailwindcss(), react()],
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
