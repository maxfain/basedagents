import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each test file boots a real HTTP API (the api workspace's Hono app) and
    // real MCP server subprocesses over stdio — generous timeouts, not speed.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
