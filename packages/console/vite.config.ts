/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The owner console (app.basedagents.ai). Talks only to the control plane over
// HTTPS with the httpOnly session cookie — no secret material ever reaches this
// app (CONTROL_PLANE.md §2: confidentiality lives in the local vault daemon).
export default defineConfig({
  plugins: [react()],
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
