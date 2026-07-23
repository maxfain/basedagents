/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Stale-tab guard (field-hit): the console ships prompt changes daily, and an
// SPA tab left open for days keeps serving its old bundle — old prompts, old
// flows — because in-app navigations never refetch index.html. Each build gets
// an id, baked into the bundle AND emitted as /version.json; the app polls the
// file and offers a refresh when they diverge (src/lib/version.ts).
const BUILD_ID = new Date().toISOString();
function versionFile(): Plugin {
  return {
    name: 'emit-version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ build: BUILD_ID }),
      });
    },
  };
}

// The owner console (app.basedagents.ai). Talks only to the control plane over
// HTTPS with the httpOnly session cookie — no secret material ever reaches this
// app (CONTROL_PLANE.md §2: confidentiality lives in the local vault daemon).
export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5174,
    // Dev proxy to the local control-plane API (packages/api `npm run dev`).
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
