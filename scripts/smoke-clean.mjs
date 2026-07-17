#!/usr/bin/env node
/**
 * Clean-container smoke test.
 *
 * The homepage/routing incident and the `basedagents keyring init` vs
 * `@basedagents/keyring init` mismatch share a root cause: nothing exercised the
 * packages the way a real user's `npx` does — from a published tarball in a
 * fresh environment, with no workspace symlinks, no dev dependencies, and no
 * pre-built dist lying around. This script does exactly that:
 *
 *   1. build + `npm pack` the `basedagents` (sdk) and `@basedagents/keyring`
 *      packages into tarballs (the real published shape);
 *   2. install BOTH tarballs into a throwaway project (fresh node_modules);
 *   3. drive the commands agents actually run and assert they work:
 *        - basedagents --version
 *        - basedagents keyring init --bare        (the NEW canonical alias)
 *        - @basedagents/keyring init --bare        (the OLD scoped invocation)
 *      Both init forms must create a real vault.
 *
 * Exits nonzero on any failure, so CI can gate on it. Uses only the tarballs +
 * their declared deps — if a dist file is missing, a bin is unresolvable, or the
 * keyring forward breaks, this fails where unit tests (which run against source)
 * would not.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'ba-smoke-'));
let failed = false;

function log(msg) { process.stdout.write(`smoke: ${msg}\n`); }
function fail(msg) { failed = true; process.stdout.write(`smoke: ✗ ${msg}\n`); }

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function pack(pkgDir) {
  // Build with the SAME script publish uses (build:dist does a clean rebuild —
  // a plain incremental `tsc` can leave a stale/partial dist). `npm pack` does
  // not run prepublishOnly, so we build explicitly first.
  const pkg = JSON.parse(readFileSync(join(ROOT, pkgDir, 'package.json'), 'utf8'));
  const buildScript = pkg.scripts?.['build:dist'] ? 'build:dist' : 'build';
  run('npm', ['run', buildScript], { cwd: join(ROOT, pkgDir) });
  const out = run('npm', ['pack', '--pack-destination', work], { cwd: join(ROOT, pkgDir) });
  const tgz = out.trim().split('\n').pop().trim();
  const full = join(work, tgz);
  if (!existsSync(full)) throw new Error(`pack did not produce ${full}`);
  return full;
}

try {
  log(`workdir ${work}`);
  log('packing basedagents (sdk) + @basedagents/keyring …');
  const sdkTgz = pack('packages/sdk');
  const keyringTgz = pack('packages/keyring');

  // Fresh project that depends only on the two published tarballs.
  const proj = join(work, 'proj');
  mkdirSync(proj, { recursive: true });
  run('npm', ['init', '-y'], { cwd: proj, stdio: 'ignore' });
  log('installing the tarballs into a fresh project …');
  run('npm', ['install', '--no-audit', '--no-fund', sdkTgz, keyringTgz], { cwd: proj });

  const sdkBin = join(proj, 'node_modules', 'basedagents', 'bin', 'basedagents.mjs');
  const keyringBin = join(proj, 'node_modules', '@basedagents', 'keyring', 'bin', 'based.mjs');
  for (const [label, bin] of [['basedagents', sdkBin], ['@basedagents/keyring', keyringBin]]) {
    if (!existsSync(bin)) fail(`${label} bin missing at ${bin}`);
  }

  // 1) basedagents --version
  try {
    const v = run(process.execPath, [sdkBin, '--version'], { cwd: proj }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) log(`✓ basedagents --version → ${v}`);
    else fail(`basedagents --version returned "${v}"`);
  } catch (e) { fail(`basedagents --version threw: ${e.message}`); }

  // 2) basedagents keyring init --bare  (NEW canonical alias → forwards to keyring)
  const vaultA = join(work, 'vault-alias');
  try {
    run(process.execPath, [sdkBin, 'keyring', 'init', '--bare', '--dir', vaultA], { cwd: proj });
    if (existsSync(join(vaultA, 'vault.json'))) log('✓ basedagents keyring init --bare created a vault');
    else fail('basedagents keyring init --bare did not create vault.json');
  } catch (e) { fail(`basedagents keyring init threw: ${e.message}`); }

  // 3) @basedagents/keyring init --bare  (OLD scoped invocation — must still work)
  const vaultB = join(work, 'vault-scoped');
  try {
    run(process.execPath, [keyringBin, 'init', '--bare', '--dir', vaultB], { cwd: proj });
    if (existsSync(join(vaultB, 'vault.json'))) log('✓ @basedagents/keyring init --bare created a vault');
    else fail('@basedagents/keyring init --bare did not create vault.json');
  } catch (e) { fail(`@basedagents/keyring init threw: ${e.message}`); }
} catch (e) {
  fail(`fatal: ${e.message}`);
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failed) {
  process.stdout.write('smoke: FAILED\n');
  process.exit(1);
}
process.stdout.write('smoke: all clean-container checks passed ✓\n');
