/**
 * MCP SDK — stdio slice, vendored into dist at build time.
 *
 * In source form this is a plain re-export and @modelcontextprotocol/sdk is a
 * devDependency. `scripts/bundle-mcp-vendor.mjs` (part of `build:dist`)
 * replaces the compiled dist/mcp/sdk-vendor.js with a self-contained esbuild
 * bundle of exactly this slice, so the published package ships no MCP SDK
 * runtime dependency — and none of the SDK's HTTP-transport subtree (express,
 * hono, jose, …), which this server never imports and which drags known npm
 * advisories into every consumer's `npm audit`.
 *
 * `zod` stays external: the schemas our tools hand to the server must be built
 * by the same zod instance the server validates with.
 */
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
