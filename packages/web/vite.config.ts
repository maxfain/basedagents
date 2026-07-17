import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        // /keyring is REQUIRED to be static (keyring page copy v1). Emitted as
        // dist/keyring.html (NOT keyring/index.html) so Cloudflare Pages serves
        // it at /keyring with a 200 — no folder-index 308 redirect to /keyring/
        // that would fight the self-canonical — and so `vite dev`/`preview`
        // resolve extension-less /keyring via the .html fallback.
        keyring: resolve(root, 'keyring.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
