/**
 * x402-supported-check.ts — the first step of the payments enable checklist.
 *
 * Signs a CDP JWT with the SAME code path the Worker uses (payments/cdp-jwt.ts)
 * and asks the facilitator what it supports. Proves three things before a
 * single bounty exists: the key id/secret pair is an Ed25519 key CDP accepts,
 * the JWT shape is right, and `eip155:8453 exact` (USDC on Base) is offered.
 *
 *   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… npx tsx scripts/x402-supported-check.ts
 *   (optional: X402_FACILITATOR_URL=… to point at a different facilitator)
 *
 * Exit 0 when Base mainnet `exact` is supported, 1 otherwise. Never touches
 * the database and never sends a payment.
 */
import { CdpFacilitator, DEFAULT_FACILITATOR_URL } from '../src/payments/cdp-facilitator.js';
import { parseEd25519Secret } from '../src/payments/cdp-jwt.js';

const keyId = process.env.CDP_API_KEY_ID;
const secret = process.env.CDP_API_KEY_SECRET;
if (!keyId || !secret) {
  console.error('Set CDP_API_KEY_ID and CDP_API_KEY_SECRET (the Ed25519 secret, base64).');
  process.exit(1);
}
try {
  parseEd25519Secret(secret);
} catch (err) {
  console.error(`CDP_API_KEY_SECRET is not an Ed25519 key: ${(err as Error).message}`);
  process.exit(1);
}

const baseUrl = process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR_URL;
const facilitator = new CdpFacilitator({ keyId, secret, baseUrl, sourceVersion: 'supported-check' });

facilitator.supported()
  .then((res) => {
    const kinds = ((res as { kinds?: Array<{ x402Version: number; scheme: string; network: string }> }).kinds ?? []);
    console.log(`facilitator: ${baseUrl}`);
    for (const k of kinds) console.log(`  v${k.x402Version} ${k.scheme} ${k.network}`);
    const ok = kinds.some((k) => k.scheme === 'exact' && k.network === 'eip155:8453');
    console.log(ok ? '\nOK: exact / eip155:8453 (USDC on Base) is supported.' : '\nFAIL: exact / eip155:8453 not offered by this facilitator.');
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`supported() failed: ${String(err)}`);
    console.error('A 401 here means the key id/secret pair is wrong or is not an Ed25519 key.');
    process.exit(1);
  });
