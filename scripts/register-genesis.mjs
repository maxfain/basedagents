/**
 * Register GenesisAgent (#1) with the basedagents.ai registry.
 * Handles: keypair gen, PoW, challenge signing, registration complete.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { writeFileSync } from 'fs';

const API = 'https://api.basedagents.ai';
const DIFFICULTY = 20; // leading zero bits

// ─── Base58 ───
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let num = BigInt('0x' + bytesToHex(bytes));
  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) result = '1' + result;
    else break;
  }
  return result;
}

// ─── Proof of Work ───
// Server expects: sha256(publicKey || hexToBytes(nonce)) with `difficulty` leading zero bits
// Nonce must be a hex string (even length)
function solvePoW(publicKey, difficulty) {
  console.log(`Solving PoW (difficulty=${difficulty})...`);
  let nonce = 0;
  const start = Date.now();
  while (true) {
    // Encode nonce as hex bytes (4 bytes, big-endian)
    const nonceHex = nonce.toString(16).padStart(8, '0');
    const nonceBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) nonceBytes[i] = parseInt(nonceHex.slice(i*2, i*2+2), 16);
    const input = new Uint8Array(publicKey.length + nonceBytes.length);
    input.set(publicKey, 0);
    input.set(nonceBytes, publicKey.length);
    const hash = sha256(input);
    // Count leading zero bits
    let zeroBits = 0;
    for (const byte of hash) {
      if (byte === 0) { zeroBits += 8; }
      else {
        for (let bit = 7; bit >= 0; bit--) {
          if ((byte >> bit) & 1) break;
          zeroBits++;
        }
        break;
      }
      if (zeroBits >= difficulty) break;
    }
    if (zeroBits >= difficulty) {
      console.log(`PoW solved in ${Date.now() - start}ms, nonce=${nonceHex}`);
      return { nonce: nonceHex, hash: bytesToHex(hash) };
    }
    nonce++;
  }
}

// ─── Main ───
async function main() {
  // 1. Generate keypair
  console.log('Generating Ed25519 keypair...');
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyB58 = base58Encode(publicKey);
  console.log(`Agent ID (public key base58): ${publicKeyB58}`);

  // 2. Register init — get challenge
  console.log('\nPOST /v1/register/init...');
  const initRes = await fetch(`${API}/v1/register/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKeyB58 }),
  });
  const init = await initRes.json();
  if (!initRes.ok) { console.error('Init failed:', init); process.exit(1); }
  console.log('Challenge received:', init);

  // 3. Solve PoW
  const { nonce } = solvePoW(publicKey, init.difficulty ?? DIFFICULTY);

  // 4. Sign challenge bytes
  const challengeData = new TextEncoder().encode(init.challenge);
  const signature = await ed.signAsync(challengeData, privateKey);
  const signatureB64 = btoa(String.fromCharCode(...signature));

  // 5. Register complete
  console.log('\nPOST /v1/register/complete...');
  const profile = {
    name: 'GenesisAgent',
    description: 'The first agent registered on the basedagents.ai registry. Proof that the network is live.',
    capabilities: ['identity', 'verification', 'registry'],
    protocols: ['https', 'agentsig'],
    offers: ['peer-verification', 'identity-anchoring'],
    needs: [],
    homepage: 'https://basedagents.ai',
    comment: 'The Times 10/Mar/2026 Trump: Iran has nothing left and war is nearly over',
  };

  const completeRes = await fetch(`${API}/v1/register/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge_id: init.challenge_id,
      public_key: publicKeyB58,
      signature: signatureB64,
      nonce,
      profile,
    }),
  });
  const result = await completeRes.json();
  if (!completeRes.ok) { console.error('Complete failed:', result); process.exit(1); }
  console.log('\n✅ Registration complete!');
  console.log(JSON.stringify(result, null, 2));

  // 6. Save keypair
  const keypairFile = {
    agent_id: result.agent_id,
    public_key_b58: publicKeyB58,
    private_key_hex: bytesToHex(privateKey),
    registered_at: new Date().toISOString(),
  };
  writeFileSync('./genesis-keypair.json', JSON.stringify(keypairFile, null, 2));
  console.log('\n🔑 Keypair saved to genesis-keypair.json — keep this safe!');
}

main().catch(console.error);
