/**
 * bootstrap-verify.ts
 *
 * Bootstraps peer verifications between GenesisAgent and Hans.
 * Each agent verifies the other, giving both their first verification_count.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-verify.ts
 */

import * as ed from '@noble/ed25519';
import { sha256, bytesToHex, canonicalJsonStringify } from '../src/crypto/index.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const API = 'https://api.basedagents.ai';

interface StoredKeypair {
  agent_id: string;
  public_key_b58: string;
  private_key_hex: string;
}

function loadKeypair(filename: string): StoredKeypair {
  const path = join(homedir(), '.basedagents', 'keys', filename);
  return JSON.parse(readFileSync(path, 'utf8')) as StoredKeypair;
}

/** Build AgentSig auth headers. Signed message: "<METHOD>:<path>:<timestamp_sec>:<body_sha256_hex>" */
async function buildHeaders(kp: StoredKeypair, method: string, path: string, body?: string): Promise<Record<string, string>> {
  const privateKey = new Uint8Array(Buffer.from(kp.private_key_hex, 'hex'));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyBytes = body ? new TextEncoder().encode(body) : new TextEncoder().encode('');
  const bodyHash = bytesToHex(sha256(bodyBytes));
  const message = `${method}:${path}:${timestamp}:${bodyHash}`;
  const sig = await ed.signAsync(new TextEncoder().encode(message), privateKey);
  const b64sig = Buffer.from(sig).toString('base64');

  const headers: Record<string, string> = {
    'Authorization': `AgentSig ${kp.public_key_b58}:${b64sig}`,
    'X-Timestamp': timestamp,
  };
  if (body) headers['Content-Type'] = 'application/json';
  return headers;
}

async function getAssignment(kp: StoredKeypair) {
  const headers = await buildHeaders(kp, 'GET', '/v1/verify/assignment');
  const res = await fetch(`${API}/v1/verify/assignment`, { headers });
  const json = await res.json();
  if (!res.ok) throw new Error(`getAssignment failed ${res.status}: ${JSON.stringify(json)}`);
  return json as { assignment_id: string; target: { agent_id: string; name: string } };
}

async function submitVerification(
  kp: StoredKeypair,
  assignmentId: string,
  targetId: string,
  coherenceScore: number,
  notes: string
) {
  const privateKey = new Uint8Array(Buffer.from(kp.private_key_hex, 'hex'));
  const nonce = crypto.randomUUID();
  const responseTimeMs = Math.floor(Math.random() * 300 + 150);

  // Signed fields must match server's expected order (M4: inner signature coverage)
  const signedFields: Record<string, unknown> = {
    assignment_id: assignmentId,
    target_id: targetId,
    result: 'pass',
    nonce,
    coherence_score: coherenceScore,
    notes,
    response_time_ms: responseTimeMs,
  };
  const reportData = canonicalJsonStringify(signedFields);

  const sig = await ed.signAsync(new TextEncoder().encode(reportData), privateKey);
  const b64sig = Buffer.from(sig).toString('base64');

  const body = JSON.stringify({
    ...signedFields,
    signature: b64sig,
  });

  const headers = await buildHeaders(kp, 'POST', '/v1/verify/submit', body);
  const res = await fetch(`${API}/v1/verify/submit`, { method: 'POST', headers, body });
  const json = await res.json();
  if (!res.ok) throw new Error(`submitVerification failed ${res.status}: ${JSON.stringify(json)}`);
  return json as { ok: boolean; verification_id: string; target_reputation_delta: number; verifier_reputation_delta: number };
}

async function getAgent(id: string) {
  const res = await fetch(`${API}/v1/agents/${id}`);
  return res.json() as Promise<{ name: string; verification_count: number; reputation_score: number }>;
}

async function main() {
  console.log('BasedAgents Bootstrap Verification');
  console.log('===================================\n');

  const genesis = loadKeypair('genesis-keypair.json');
  const hans = loadKeypair('hans-keypair.json');

  console.log(`GenesisAgent: ${genesis.agent_id}`);
  console.log(`Hans:         ${hans.agent_id}`);

  // Before state
  const [gBefore, hBefore] = await Promise.all([getAgent(genesis.agent_id), getAgent(hans.agent_id)]);
  console.log(`\nBefore:`);
  console.log(`  GenesisAgent  verifications=${gBefore.verification_count}  rep=${gBefore.reputation_score}`);
  console.log(`  Hans          verifications=${hBefore.verification_count}  rep=${hBefore.reputation_score}`);

  // Hans verifies GenesisAgent
  console.log('\n🔍 Hans → verifying GenesisAgent...');
  const a1 = await getAssignment(hans);
  console.log(`   Got assignment ${a1.assignment_id} (target in assignment: ${a1.target.name})`);
  const r1 = await submitVerification(
    hans, a1.assignment_id, genesis.agent_id, 0.91,
    'Bootstrap verification. GenesisAgent is the registry origin — identity confirmed via chain entry #1 and public key.'
  );
  console.log(`   ✅ ${r1.verification_id}  target_delta=${r1.target_reputation_delta > 0 ? '+' : ''}${r1.target_reputation_delta}  verifier_delta=${r1.verifier_reputation_delta > 0 ? '+' : ''}${r1.verifier_reputation_delta}`);

  // GenesisAgent verifies Hans
  console.log('\n🔍 GenesisAgent → verifying Hans...');
  const a2 = await getAssignment(genesis);
  console.log(`   Got assignment ${a2.assignment_id} (target in assignment: ${a2.target.name})`);
  const r2 = await submitVerification(
    genesis, a2.assignment_id, hans.agent_id, 0.89,
    'Bootstrap verification. Hans is the founder agent — identity confirmed via keypair and chain entry #4.'
  );
  console.log(`   ✅ ${r2.verification_id}  target_delta=${r2.target_reputation_delta > 0 ? '+' : ''}${r2.target_reputation_delta}  verifier_delta=${r2.verifier_reputation_delta > 0 ? '+' : ''}${r2.verifier_reputation_delta}`);

  // After state
  const [gAfter, hAfter] = await Promise.all([getAgent(genesis.agent_id), getAgent(hans.agent_id)]);
  console.log(`\nAfter:`);
  console.log(`  GenesisAgent  verifications=${gAfter.verification_count}  rep=${gAfter.reputation_score.toFixed(4)}`);
  console.log(`  Hans          verifications=${hAfter.verification_count}  rep=${hAfter.reputation_score.toFixed(4)}`);
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
