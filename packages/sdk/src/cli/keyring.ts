/**
 * `basedagents keyring <args>` — a thin alias that forwards to the BasedAgents
 * Keyring CLI (the @basedagents/keyring package).
 *
 * Why this exists: the docs, marketing, and agent.json canonicalize
 * `npx basedagents keyring init`, but the keyring ships as its own package whose
 * bin is `npx @basedagents/keyring init`. BOTH must work — agents run stale
 * commands out of cached docs for months, so neither form can 404.
 *
 * Resolution order:
 *   1. A locally-installed @basedagents/keyring (monorepo, or a user who has
 *      both) — run its bin directly, no network.
 *   2. Otherwise fetch it on demand via `npx -y @basedagents/keyring`.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/** Resolve the installed keyring bin (based.mjs) if the package is present. */
function resolveLocalKeyringBin(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // The package's "." export resolves to dist/index.js; the bin sits at
    // <pkg root>/bin/based.mjs (package.json `files` ships `bin`).
    const mainJs = require.resolve('@basedagents/keyring');
    const bin = path.resolve(path.dirname(mainJs), '..', 'bin', 'based.mjs');
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export async function keyring(args: string[]): Promise<void> {
  const local = resolveLocalKeyringBin();

  let res: SpawnSyncReturns<Buffer>;
  if (local) {
    res = spawnSync(process.execPath, [local, ...args], { stdio: 'inherit' });
  } else {
    const isWin = process.platform === 'win32';
    // -y auto-confirms the one-time npx install prompt.
    res = spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', '@basedagents/keyring', ...args], {
      stdio: 'inherit',
      shell: isWin,
    });
  }

  if (res.error) {
    const isEnoent = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    console.error(`\nCould not run the keyring CLI: ${res.error.message}`);
    if (isEnoent && !local) {
      console.error('This alias fetches @basedagents/keyring via npx — make sure npm/npx is installed and');
      console.error('registry.npmjs.org is reachable (behind a proxy, allow it).');
    }
    console.error(`Direct equivalent: npx @basedagents/keyring ${args.join(' ')}\n`);
    process.exit(1);
  }
  // Propagate the child's exit status (signal → nonzero).
  process.exit(res.status ?? (res.signal ? 1 : 0));
}
