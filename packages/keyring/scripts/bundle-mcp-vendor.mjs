#!/usr/bin/env node
/**
 * Replace dist/mcp/sdk-vendor.js (tsc's plain re-export) with a self-contained
 * bundle of the MCP SDK's stdio slice, then prove the bundle is what we think
 * it is:
 *   - only allowlisted packages inside (never the express/hono/jose HTTP subtree)
 *   - the only external imports are zod (shared with our tool schemas) and node:*
 *   - the re-export actually got overwritten (size sanity)
 * Any drift after an SDK upgrade fails the build loudly instead of silently
 * re-inflating the dependency tree.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(pkgDir, 'dist', 'mcp', 'sdk-vendor.js');

// The SDK's exports map aliases ./package.json to a {"type"} stub, so derive
// the real package root from a resolved entry module instead.
const sdkEntry = require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
const sdkRoot = sdkEntry.slice(0, sdkEntry.lastIndexOf(`node_modules${path.sep}@modelcontextprotocol${path.sep}sdk`)) +
  path.join('node_modules', '@modelcontextprotocol', 'sdk');
const sdkVersion = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;

// Every package allowed inside the bundle. The non-SDK entries are the SDK's
// pure JSON-Schema helpers — no network, no HTTP servers, no crypto.
const ALLOWED = new Set([
  '@modelcontextprotocol/sdk',
  'zod-to-json-schema',
  'ajv',
  'ajv-formats',
  'fast-deep-equal',
  'fast-uri',
  'json-schema-traverse',
]);

const result = await build({
  entryPoints: [path.join(pkgDir, 'src', 'mcp', 'sdk-vendor.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['zod', 'zod/*'],
  outfile,
  metafile: true,
  logLevel: 'warning',
  banner: {
    js: `/* Bundled stdio slice of @modelcontextprotocol/sdk v${sdkVersion} (MIT, © Anthropic, PBC). See src/mcp/sdk-vendor.ts for why. */`,
  },
});

const packageOf = (input) => {
  const idx = input.lastIndexOf('node_modules/');
  if (idx === -1) return null;
  const parts = input.slice(idx + 'node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
};

const offenders = new Set(
  Object.keys(result.metafile.inputs).map(packageOf).filter((p) => p && !ALLOWED.has(p))
);
if (offenders.size) {
  console.error(`sdk-vendor bundle pulled in unexpected packages: ${[...offenders].join(', ')}`);
  console.error('The SDK upgrade changed its stdio-path imports — re-audit before widening ALLOWED.');
  process.exit(1);
}

const outKey = Object.keys(result.metafile.outputs).find((k) => k.endsWith('sdk-vendor.js'));
const badExternals = (result.metafile.outputs[outKey].imports ?? [])
  .map((i) => i.path)
  .filter((p) => !(p === 'zod' || p.startsWith('zod/') || p.startsWith('node:')));
if (badExternals.length) {
  console.error(`sdk-vendor bundle left unexpected external imports: ${badExternals.join(', ')}`);
  process.exit(1);
}

const size = statSync(outfile).size;
if (size < 200_000) {
  console.error(`dist/mcp/sdk-vendor.js is only ${size} bytes — the bundle overwrite did not happen.`);
  process.exit(1);
}

console.log(
  `vendored MCP SDK v${sdkVersion} stdio slice → dist/mcp/sdk-vendor.js ` +
  `(${Math.round(size / 1024)} KB, ${Object.keys(result.metafile.inputs).length} inputs, externals: zod + node builtins)`
);
