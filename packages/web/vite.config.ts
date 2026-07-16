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
        // /keyring is REQUIRED to be static (keyring page copy v1): a second
        // HTML entry emitted at dist/keyring/index.html, which Cloudflare
        // Pages serves as plain HTML before the SPA fallback in _redirects.
        keyring: resolve(root, 'keyring/index.html'),
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
