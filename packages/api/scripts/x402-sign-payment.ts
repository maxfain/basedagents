/**
 * Sign an x402 PaymentRequired from the terminal (dry runs, staging, canaries).
 *
 *   BUYER_PRIVATE_KEY=0x… npx tsx scripts/x402-sign-payment.ts < payreq.json > payload.b64
 *
 * Reads the 402 body the API printed (`basedagents tasks post … --bounty` or
 * `tasks accept` exit 2 with it on stdout, or GET /v1/tasks/:id/payment's
 * `payment_required`), signs `accepts[0]` as an EIP-3009
 * TransferWithAuthorization with the buyer's secp256k1 key, and prints the
 * base64 x402 v2 payment payload — exactly what `--payment-signature @file`
 * or the PAYMENT-SIGNATURE header wants. Same signing code the house wallet
 * uses (payments/house-wallet.ts), so a payload that verifies here verifies
 * there. `--stdout-json` prints the payload as JSON instead of base64.
 *
 * The key never leaves this process; nothing is written anywhere but stdout.
 */
import { houseWalletFromPrivateKey, parseHousePrivateKey } from '../src/payments/house-wallet.js';
import { encodeB64Json, PaymentRequirementsV2 } from '../src/payments/x402.js';

const raw = process.env.BUYER_PRIVATE_KEY;
if (!raw) {
  console.error('BUYER_PRIVATE_KEY is not set (0x-prefixed 64-hex secp256k1 key of the wallet that pays)');
  process.exit(1);
}

const input = await new Promise<string>((resolve) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => resolve(buf));
});
let body: { accepts?: unknown[]; payment_required?: { accepts?: unknown[] } };
try {
  body = JSON.parse(input);
} catch {
  console.error('stdin is not JSON — pipe the 402 body (or GET /payment) in');
  process.exit(1);
}
const first = body.accepts?.[0] ?? body.payment_required?.accepts?.[0];
if (!first) {
  console.error('no accepts[0] in the input — is this a PaymentRequired?');
  process.exit(1);
}
const requirements = PaymentRequirementsV2.parse(first);
const signer = houseWalletFromPrivateKey(parseHousePrivateKey(raw));
const payload = signer.signTransfer(requirements, Math.floor(Date.now() / 1000));

console.error(`signed: ${requirements.amount} atomic USDC from ${signer.address} to ${requirements.payTo} on ${requirements.network} (validBefore ${payload.payload.authorization.validBefore})`);
process.stdout.write(process.argv.includes('--stdout-json') ? JSON.stringify(payload) : encodeB64Json(payload));
