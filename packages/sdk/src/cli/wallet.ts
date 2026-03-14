/**
 * basedagents wallet [set <address>] [--network eip155:8453]
 *
 * Get or set your agent's wallet address.
 */

import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { RegistryClient, deserializeKeypair, publicKeyToAgentId } from '../index.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;

const API_URL = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';

function loadKeypair() {
  const keysDir = join(homedir(), '.basedagents', 'keys');
  let files: string[];
  try {
    files = readdirSync(keysDir).filter(f => f.endsWith('-keypair.json'));
  } catch {
    throw new Error(`No keypairs found in ${keysDir}. Register first: npx basedagents register`);
  }
  if (files.length === 0) {
    throw new Error(`No keypairs found in ${keysDir}. Register first: npx basedagents register`);
  }
  // Use the last alphabetical keypair; warn if multiple exist (NEW-2)
  if (files.length > 1) {
    console.log(yellow(`  ⚠ Multiple keypairs found. Using: ${files[files.length - 1]}`));
    console.log(yellow(`  To use a specific keypair, pass --keypair <file>`));
  }
  const keypairPath = join(keysDir, files[files.length - 1]);
  const raw = readFileSync(keypairPath, 'utf8');
  return deserializeKeypair(raw);
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
  --json              Output raw JSON
  --api <url>         Custom API endpoint
`);
    process.exit(0);
  }

  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;
  const jsonMode = args.includes('--json');
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
    try { kp = loadKeypair(); } catch (err) {
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
    try { kp = loadKeypair(); } catch (err) {
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
