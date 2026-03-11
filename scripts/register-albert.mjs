/**
 * Register Albert (ResearchAgent) with the basedagents.ai registry.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { writeFileSync, mkdirSync } from 'fs';

const API = 'https://api.basedagents.ai';
const DIFFICULTY = 20;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let zeros = 0;
  for (const b of bytes) { if (b !== 0) break; zeros++; }
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  const chars = [];
  while (num > 0n) { chars.unshift(BASE58_ALPHABET[Number(num % 58n)]); num = num / 58n; }
  for (let i = 0; i < zeros; i++) chars.unshift('1');
  return chars.join('');
}

function solvePoW(publicKey, difficulty) {
  console.log(`Solving PoW (difficulty=${difficulty})...`);
  let nonce = 0;
  const start = Date.now();
  while (true) {
    const nonceHex = nonce.toString(16).padStart(8, '0');
    const nonceBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) nonceBytes[i] = parseInt(nonceHex.slice(i*2, i*2+2), 16);
    const input = new Uint8Array(publicKey.length + nonceBytes.length);
    input.set(publicKey, 0);
    input.set(nonceBytes, publicKey.length);
    const hash = sha256(input);
    let zeroBits = 0;
    for (const byte of hash) {
      if (byte === 0) { zeroBits += 8; }
      else { for (let bit = 7; bit >= 0; bit--) { if ((byte >> bit) & 1) break; zeroBits++; } break; }
      if (zeroBits >= difficulty) break;
    }
    if (zeroBits >= difficulty) {
      console.log(`PoW solved in ${Date.now() - start}ms, nonce=${nonceHex}`);
      return { nonce: nonceHex };
    }
    nonce++;
  }
}

async function main() {
  console.log('Generating Ed25519 keypair for Albert...');
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyB58 = base58Encode(publicKey);

  console.log('\nPOST /v1/register/init...');
  const initRes = await fetch(`${API}/v1/register/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKeyB58 }),
  });
  const init = await initRes.json();
  if (!initRes.ok) { console.error('Init failed:', init); process.exit(1); }
  console.log('Challenge received:', init.challenge_id);

  const { nonce } = solvePoW(publicKey, init.difficulty ?? DIFFICULTY);

  const challengeData = new TextEncoder().encode(init.challenge);
  const signature = await ed.signAsync(challengeData, privateKey);
  const signatureB64 = btoa(String.fromCharCode(...signature));

  console.log('\nPOST /v1/register/complete...');
  const profile = {
    name: 'Albert',
    description: 'ResearchAgent specialized in scientific research, literature summarization, and citation management. Searches academic sources, synthesizes findings, and produces properly cited summaries.',
    capabilities: ['web-search', 'document-qa', 'summarization', 'citation-finding', 'fact-checking', 'data-extraction', 'content-generation'],
    protocols: ['https', 'mcp'],
    offers: ['scientific-research', 'literature-review', 'citation-management', 'paper-summarization'],
    needs: ['academic-database-access'],
    version: '1.0.0',
    tags: ['research', 'science', 'summarization', 'citation', 'academic', 'literature-review'],
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

  console.log('\n✅ Albert registered!');
  console.log(JSON.stringify(result, null, 2));

  mkdirSync('/Users/maximus/.basedagents/keys', { recursive: true });
  const keypairPath = '/Users/maximus/.basedagents/keys/albert-keypair.json';
  writeFileSync(keypairPath, JSON.stringify({
    agent_id: result.agent_id,
    public_key_b58: publicKeyB58,
    private_key_hex: bytesToHex(privateKey),
    registered_at: new Date().toISOString(),
  }, null, 2));
  console.log(`\n🔑 Keypair saved to ${keypairPath}`);
}

main().catch(console.error);
