/**
 * basedagents wallet [set <address>] [--network eip155:8453]
 *
 * Get or set your agent's wallet address.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, win32 } from 'path';
import { RegistryClient, DEFAULT_API_URL, deserializeKeypair, publicKeyToAgentId, type AgentKeypair } from '../index.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;

const API_URL = DEFAULT_API_URL;

/**
 * Load the agent keypair the CLI signs with, from the file `resolveKeypairPath`
 * picks. Shared by every authenticated command.
 */
export function loadKeypair(keypairFile?: string): AgentKeypair {
  return deserializeKeypair(readFileSync(resolveKeypairPath(keypairFile), 'utf8'));
}

/**
 * Whether a --keypair value names a file by path rather than by name inside
 * ~/.basedagents/keys/: it has a directory part in either separator, or it is
 * absolute (POSIX, a Windows drive path, or a UNC path). A Windows path such as
 * `C:\Users\me\.basedagents\keys\me-keypair.json` has no `/` at all.
 */
export function isKeypairPath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || isAbsolute(value) || win32.isAbsolute(value);
}

/**
 * The file `loadKeypair` reads, in order:
 *   1. --keypair: a path, or a filename in ~/.basedagents/keys/;
 *   2. BASEDAGENTS_KEYPAIR_PATH, the variable the MCP server reads (and that
 *      `basedagents init` tells you to set);
 *   3. the last `*-keypair.json` in ~/.basedagents/keys/ (the order readdirSync
 *      returns, which is sorted).
 * Shared with `basedagents id` so the path it reports is the key it used.
 * Warnings go to stderr so a command's `--json` stdout stays one parseable object.
 */
export function resolveKeypairPath(keypairFile?: string, env: NodeJS.ProcessEnv = process.env): string {
  const keysDir = join(homedir(), '.basedagents', 'keys');
  if (keypairFile) return isKeypairPath(keypairFile) ? keypairFile : join(keysDir, keypairFile);
  const fromEnv = env.BASEDAGENTS_KEYPAIR_PATH?.trim();
  if (fromEnv) return fromEnv;
  let files: string[];
  try {
    // readdirSync already returns names sorted (libuv scandir, strcmp), so this is
    // the same "last alphabetical" file every earlier CLI picked; no re-sort, so
    // an upgrade can never switch which identity signs.
    files = readdirSync(keysDir).filter(f => f.endsWith('-keypair.json'));
  } catch {
    throw new Error(`No keypairs found in ${keysDir}. Register first: npx basedagents register`);
  }
  if (files.length === 0) {
    throw new Error(`No keypairs found in ${keysDir}. Register first: npx basedagents register`);
  }
  // Use the last alphabetical keypair; warn if multiple exist (NEW-2)
  if (files.length > 1) {
    console.error(yellow(`  ⚠ Multiple keypairs found. Using: ${files[files.length - 1]}`));
    console.error(yellow(`  To use a specific keypair, pass --keypair <file> or set BASEDAGENTS_KEYPAIR_PATH`));
  }
  return join(keysDir, files[files.length - 1]);
}

/**
 * Where a new registration saves its keypair, chosen before the proof-of-work
 * (its directory is created here, so an unwritable location fails before the
 * registration rather than after it). BASEDAGENTS_KEYPAIR_PATH wins when it is
 * set and names no file yet: that is where every signed command will look.
 * Otherwise ~/.basedagents/keys/<slug>-keypair.json, numbered past any existing
 * file. `envInUse` is set when the variable names an existing file; the new key
 * then goes to the keys directory, and signed commands keep using the
 * variable's key until it changes.
 */
export function prepareNewKeypairPath(slug: string, env: NodeJS.ProcessEnv = process.env): { path: string; envInUse?: string } {
  const fromEnv = env.BASEDAGENTS_KEYPAIR_PATH?.trim();
  if (fromEnv && !existsSync(fromEnv)) {
    mkdirSync(dirname(fromEnv), { recursive: true });
    return { path: fromEnv };
  }
  const keysDir = join(homedir(), '.basedagents', 'keys');
  mkdirSync(keysDir, { recursive: true });
  let path = join(keysDir, `${slug}-keypair.json`);
  for (let i = 2; existsSync(path); i++) path = join(keysDir, `${slug}-${i}-keypair.json`);
  return fromEnv ? { path, envInUse: fromEnv } : { path };
}

/**
 * Write a just-registered keypair (mode 0600), never replacing a file. If
 * `path` can't be written (a file appeared there since it was chosen, or the
 * location stopped being writable), the key goes to a fresh numbered file in
 * ~/.basedagents/keys/ instead, so a registration that succeeded never loses
 * its key. Returns where the file landed.
 */
export function saveNewKeypair(path: string, contents: string, slug: string): string {
  try {
    writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
    return path;
  } catch {
    const fallback = prepareNewKeypairPath(slug, {}).path;
    writeFileSync(fallback, contents, { mode: 0o600, flag: 'wx' });
    console.error(yellow(`  ⚠ Could not write ${path}; the keypair was saved to ${fallback} instead.`));
    return fallback;
  }
}

export async function wallet(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${bold('basedagents wallet')} ${dim('[set <address>] [--network eip155:8453]')}

Get or set your agent's wallet address.

${bold('Usage:')}
  basedagents wallet                                    Show current wallet
  basedagents wallet set 0x1234...abcd                  Set wallet address
  basedagents wallet set 0x1234...abcd --network eip155:8453

${bold('Options:')}
  --network <chain>   Chain ID (default: eip155:8453 = Base mainnet)
  --keypair <file>    Path to keypair file (or filename in ~/.basedagents/keys/);
                      default $BASEDAGENTS_KEYPAIR_PATH, else the last key there
  --json              Output raw JSON
  --api <url>         Custom API endpoint
`);
    process.exit(0);
  }

  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;
  const jsonMode = args.includes('--json');
  const keypairFile = args.includes('--keypair') ? args[args.indexOf('--keypair') + 1] : undefined;
  const client = new RegistryClient(apiUrl);

  const subcommand = args[0];

  if (subcommand === 'set') {
    const address = args[1];
    if (!address || !(/^0x[a-fA-F0-9]{40}$/.test(address))) {
      console.log(red('\n  Invalid wallet address. Must be a 0x-prefixed 40-hex-char EVM address.\n'));
      process.exit(1);
    }

    const networkIdx = args.indexOf('--network');
    const network = networkIdx !== -1 && args[networkIdx + 1] ? args[networkIdx + 1] : undefined;

    let kp;
    try { kp = loadKeypair(keypairFile); } catch (err) {
      console.log(red(`\n  ${err instanceof Error ? err.message : 'Failed to load keypair'}\n`));
      process.exit(1);
    }

    try {
      const result = await client.updateWallet(kp, {
        wallet_address: address,
        ...(network ? { wallet_network: network } : {}),
      });

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log('');
      console.log(`  ${green('✓')} Wallet updated`);
      console.log(`  ${dim('Agent ID')}   ${cyan(result.agent_id)}`);
      console.log(`  ${dim('Address')}    ${result.wallet_address}`);
      console.log(`  ${dim('Network')}    ${result.wallet_network ?? 'eip155:8453'}`);
      console.log('');
    } catch (err) {
      console.log(red(`\n  Failed to update wallet: ${err instanceof Error ? err.message : 'unknown error'}\n`));
      process.exit(1);
    }
  } else {
    // Show wallet for current agent
    let kp;
    try { kp = loadKeypair(keypairFile); } catch (err) {
      console.log(red(`\n  ${err instanceof Error ? err.message : 'Failed to load keypair'}\n`));
      process.exit(1);
    }

    const agentId = publicKeyToAgentId(kp.publicKey);

    try {
      const result = await client.getWallet(agentId);

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log('');
      console.log(`  ${dim('Agent ID')}   ${cyan(result.agent_id)}`);
      if (result.wallet_address) {
        console.log(`  ${dim('Address')}    ${result.wallet_address}`);
        console.log(`  ${dim('Network')}    ${result.wallet_network ?? 'eip155:8453'}`);
      } else {
        console.log(`  ${dim('No wallet set. Use:')} basedagents wallet set 0x...`);
      }
      console.log('');
    } catch (err) {
      console.log(red(`\n  Failed to fetch wallet: ${err instanceof Error ? err.message : 'unknown error'}\n`));
      process.exit(1);
    }
  }
}
