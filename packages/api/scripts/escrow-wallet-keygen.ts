/**
 * Generate the escrow (house) wallet key — or print the address of an existing one.
 *
 *   npx tsx scripts/escrow-wallet-keygen.ts            # new key: prints the private key + address
 *   ESCROW_WALLET_PRIVATE_KEY=0x… npx tsx scripts/escrow-wallet-keygen.ts   # address of a key you already hold
 *
 * The private key is 32 random bytes from the platform CSPRNG, validated with the
 * exact parser the Worker uses (`parseHousePrivateKey`), and the address is
 * derived with the same code that signs releases and refunds. Nothing is
 * written anywhere: pipe the key straight into wrangler and back it up offline —
 * it holds buyers' USDC, and a new key cannot move deposits the old one holds.
 *
 *   ESCROW_WALLET_PRIVATE_KEY=$(npx tsx scripts/escrow-wallet-keygen.ts --key-only)
 *   printf '%s' "$ESCROW_WALLET_PRIVATE_KEY" | npx wrangler secret put ESCROW_WALLET_PRIVATE_KEY --env staging
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressFromPrivateKey, parseHousePrivateKey } from '../src/payments/house-wallet.js';

const keyOnly = process.argv.includes('--key-only');
const existing = process.env.ESCROW_WALLET_PRIVATE_KEY;

let keyHex: string;
if (existing) {
  keyHex = existing.trim();
} else {
  const bytes = secp256k1.utils.randomPrivateKey(); // CSPRNG, rejection-sampled into the curve order
  keyHex = '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const key = parseHousePrivateKey(keyHex); // throws on anything the Worker would refuse
const address = addressFromPrivateKey(key);

if (keyOnly) {
  process.stdout.write(keyHex);
} else if (existing) {
  console.log(`address: ${address}`);
} else {
  console.error('Escrow wallet key generated. Store the private key offline before you set it as a secret.\n');
  console.log(`ESCROW_WALLET_PRIVATE_KEY=${keyHex}`);
  console.log(`address=${address}`);
  console.error('\nThis wallet will hold buyers\' USDC. It needs no ETH. Fund nothing until the secret is set and a staging task ran end to end.');
}
