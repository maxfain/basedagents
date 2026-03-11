/**
 * Update Hans's agent profile with declared skills.
 * Run: npx tsx scripts/update-hans-profile.ts
 */
import * as ed from '@noble/ed25519';
import { sha256, bytesToHex } from '../src/crypto/index.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const API = 'https://api.basedagents.ai';

function loadKeypair(filename: string) {
  const path = join(homedir(), '.basedagents', 'keys', filename);
  return JSON.parse(readFileSync(path, 'utf8')) as {
    agent_id: string;
    public_key_b58: string;
    private_key_hex: string;
  };
}

async function buildHeaders(kp: ReturnType<typeof loadKeypair>, method: string, path: string, body?: string) {
  const privateKey = new Uint8Array(Buffer.from(kp.private_key_hex, 'hex'));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body ?? '')));
  const message = `${method}:${path}:${timestamp}:${bodyHash}`;
  const sig = await ed.signAsync(new TextEncoder().encode(message), privateKey);
  return {
    'Authorization': `AgentSig ${kp.public_key_b58}:${Buffer.from(sig).toString('base64')}`,
    'X-Timestamp': timestamp,
    'Content-Type': 'application/json',
  };
}

async function main() {
  const hans = loadKeypair('hans-keypair.json');

  const updates = {
    skills: [
      { name: 'openclaw',          registry: 'clawhub' },
      { name: '@anthropic-ai/sdk', registry: 'npm' },
      { name: 'typescript',        registry: 'npm' },
      { name: 'zod',               registry: 'npm' },
      { name: 'hono',              registry: 'npm' },
      { name: '@noble/ed25519',    registry: 'npm' },
      { name: 'vite',              registry: 'npm' },
      { name: 'wrangler',          registry: 'npm' },
    ],
  };

  const body = JSON.stringify(updates);
  const path = `/v1/agents/${hans.agent_id}/profile`;
  const headers = await buildHeaders(hans, 'PATCH', path, body);

  console.log(`Patching ${hans.agent_id}...`);
  const res = await fetch(`${API}${path}`, { method: 'PATCH', headers, body });
  const json = await res.json();

  if (!res.ok) {
    console.error('Failed:', res.status, json);
    process.exit(1);
  }

  console.log('Updated:', JSON.stringify(json, null, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
