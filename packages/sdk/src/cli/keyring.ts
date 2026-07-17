/**
 * `basedagents keyring <args>` — a thin alias that forwards to the BasedAgents
 * Keyring CLI (the @basedagents/keyring package).
 *
 * Why this exists: the docs, marketing, and agent.json canonicalize
 * `npx basedagents keyring init`, but the keyring ships as its own package whose
 * bin is `npx @basedagents/keyring init`. BOTH must work — agents run stale
 * commands out of cached docs for months, so neither form can 404.
 *
 * Static dependency rule (homepage spec §4.6): @basedagents/keyring is a real
 * dependency of `basedagents`, so installing `basedagents` (including via `npx
 * basedagents`, which fetches deps) always brings the keyring with it. This
 * alias therefore resolves the LOCAL copy and NEVER dynamic-fetches — a network
 * call at this point would break inside a network-restricted sandbox whose task
 * phase has no egress. If the local copy is somehow missing, we fail with a
 * reinstall hint rather than silently reaching for the registry.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * Resolve the installed keyring bin (based.mjs) by walking node_modules.
 *
 * We deliberately do NOT use `require.resolve('@basedagents/keyring')`: the
 * keyring package's "exports" map declares only an `import` condition (no
 * `require`) and doesn't export `./package.json`, so CJS specifier resolution is
 * blocked even when the package is installed right next to us. A plain
 * filesystem walk up the node_modules chain isn't exports-gated and is robust to
 * both hoisted installs and the npx cache layout — and it never touches the
 * network, which is the whole point (§4.6 offline guarantee).
 */
function resolveLocalKeyringBin(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const bin = path.join(dir, 'node_modules', '@basedagents', 'keyring', 'bin', 'based.mjs');
    if (existsSync(bin)) return bin;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export async function keyring(args: string[]): Promise<void> {
  const local = resolveLocalKeyringBin();

  if (!local) {
    // @basedagents/keyring is a declared dependency, so this only happens on a
    // broken/partial install. Do NOT fetch it over the network — point the user
    // at a reinstall so the offline guarantee holds.
    console.error('\nThe BasedAgents Keyring CLI is not resolvable from this install of `basedagents`.');
    console.error('@basedagents/keyring ships as a dependency — a reinstall should restore it:');
    console.error('  npm install basedagents          (or: npm install @basedagents/keyring)');
    console.error(`Direct equivalent, if you have it installed: npx @basedagents/keyring ${args.join(' ')}\n`);
    process.exit(1);
  }

  const res: SpawnSyncReturns<Buffer> = spawnSync(process.execPath, [local, ...args], {
    stdio: 'inherit',
  });

  if (res.error) {
    console.error(`\nCould not run the keyring CLI: ${res.error.message}`);
    console.error(`Direct equivalent: npx @basedagents/keyring ${args.join(' ')}\n`);
    process.exit(1);
  }
  // Propagate the child's exit status (signal → nonzero).
  process.exit(res.status ?? (res.signal ? 1 : 0));
}
