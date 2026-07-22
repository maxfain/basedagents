/**
 * The cloud passport (SANDBOX_SPEC §4b) — identity + vault authority for
 * VAULT-LESS sandbox agents.
 *
 * A vault inside an ephemeral container makes no sense: the container holds
 * nothing durable. Identity (agent keypair) and authority (owner keypair —
 * the key the owner id derives from and every sealed box is pinned to) load
 * from the BASEDAGENTS_PASSPORT environment secret, and the working set of
 * sealed credentials re-materializes each task from the control-plane shelf
 * (ciphertext only, served exclusively over proof-of-possession of the same
 * owner key).
 *
 * The passport is born in the FIRST task's container (where init generates
 * the keys today) and reaches the human sealed to an ephemeral browser key —
 * it never appears in the agent transcript and the control plane can never
 * open it. Format is versioned: v1 = this blob; v2 (later) adds passkey-PRF
 * wrapping for ask-me-every-time credentials.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keyring } from '../keyring.js';
import { VaultStore } from '../store.js';
import type { AgentKeypair } from '../crypto.js';
import type { Credential, Grant, VaultFile } from '../types.js';
import { base58Encode, base58Decode, hexToBytes, publicKeyToAgentId } from '../util.js';
import { bytesToHex } from '@noble/hashes/utils';

export const PASSPORT_ENV = 'BASEDAGENTS_PASSPORT';

export interface ParsedPassport {
  owner: AgentKeypair;
  agent: AgentKeypair;
  agentId: string;
  name: string;
}

/** Serialize the passport as base64(JSON) — the exact string sealed to the browser. */
export function buildPassportBlob(owner: AgentKeypair, agent: AgentKeypair, name: string): string {
  const body = {
    v: 1,
    owner: { public_key_b58: base58Encode(owner.publicKey), private_key_hex: bytesToHex(owner.privateKey) },
    agent: {
      agent_id: publicKeyToAgentId(agent.publicKey),
      public_key_b58: base58Encode(agent.publicKey),
      private_key_hex: bytesToHex(agent.privateKey),
    },
    name,
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

export function parsePassportBlob(blob: string): ParsedPassport {
  let body: {
    v?: number;
    owner?: { public_key_b58?: string; private_key_hex?: string };
    agent?: { agent_id?: string; public_key_b58?: string; private_key_hex?: string };
    name?: string;
  };
  try {
    body = JSON.parse(Buffer.from(blob.trim(), 'base64').toString('utf8'));
  } catch {
    throw new Error(`${PASSPORT_ENV} is not a valid passport (not base64 JSON)`);
  }
  if (body.v !== 1) throw new Error(`${PASSPORT_ENV} has version ${body.v} — this build understands v1`);
  if (!body.owner?.public_key_b58 || !body.owner?.private_key_hex || !body.agent?.public_key_b58 || !body.agent?.private_key_hex) {
    throw new Error(`${PASSPORT_ENV} is missing key material`);
  }
  const owner: AgentKeypair = {
    publicKey: base58Decode(body.owner.public_key_b58),
    privateKey: hexToBytes(body.owner.private_key_hex),
  };
  const agent: AgentKeypair = {
    publicKey: base58Decode(body.agent.public_key_b58),
    privateKey: hexToBytes(body.agent.private_key_hex),
  };
  return { owner, agent, agentId: publicKeyToAgentId(agent.publicKey), name: body.name ?? 'Cloud agent' };
}

// ─── The shelf wire format (mirrors the control plane's sealed_credentials) ───

export interface ShelfRow {
  credential_id: string;
  v: number;
  meta: string;   // JSON CredentialPublic
  sealed: string; // JSON Record<agent_id, base64 sealed box>
  grants: string; // JSON Grant[]
}

/** Vault → shelf snapshot: ciphertext + metadata, verbatim, never plaintext. */
export function buildShelfSnapshot(vault: VaultFile): ShelfRow[] {
  return Object.values(vault.credentials).map((cred) => {
    const { sealed, ...meta } = cred;
    return {
      credential_id: cred.credential_id,
      v: 1,
      meta: JSON.stringify(meta),
      sealed: JSON.stringify(sealed),
      grants: JSON.stringify(Object.values(vault.grants).filter((g) => g.credential_id === cred.credential_id)),
    };
  });
}

/**
 * Materialize a working vault CACHE in `dir` from the passport + shelf rows.
 * Everything written here is disposable: same sealed boxes the shelf holds,
 * a fresh event chain, and the owner key the passport already carries.
 * Refuses to overwrite a vault that belongs to a DIFFERENT owner.
 */
export function materializeVault(
  dir: string | undefined,
  passport: ParsedPassport,
  shelf: ShelfRow[],
): Keyring {
  const store = new VaultStore(dir);
  const ownerPubB58 = base58Encode(passport.owner.publicKey);
  const ownerAgentId = publicKeyToAgentId(passport.owner.publicKey);

  let existing: VaultFile | null = null;
  if (store.exists()) {
    existing = store.readVault();
    if (existing.owner.public_key_b58 !== ownerPubB58) {
      throw new Error(
        `A vault for a different setup already exists at ${dir} — unset ${PASSPORT_ENV} or point BASEDAGENTS_KEYRING_DIR elsewhere.`,
      );
    }
  }

  const credentials: Record<string, Credential> = {};
  const grants: Record<string, Grant> = {};
  for (const row of shelf) {
    const meta = JSON.parse(row.meta) as Omit<Credential, 'sealed'>;
    const sealed = JSON.parse(row.sealed) as Record<string, string>;
    credentials[row.credential_id] = { ...meta, sealed };
    for (const g of JSON.parse(row.grants) as Grant[]) grants[g.grant_id] = g;
  }

  const vault: VaultFile = {
    version: 1,
    created_at: existing?.created_at ?? new Date().toISOString(),
    owner: { agent_id: ownerAgentId, public_key_b58: ownerPubB58 },
    identities: {
      ...(existing?.identities ?? {}),
      [passport.agentId]: {
        agent_id: passport.agentId,
        name: passport.name,
        added_at: existing?.identities?.[passport.agentId]?.added_at ?? new Date().toISOString(),
      },
    },
    credentials,
    grants,
    requests: existing?.requests ?? {},
    ...(existing?.owner_passkeys ? { owner_passkeys: existing.owner_passkeys } : {}),
    ...(existing?.applied_approval_nonces ? { applied_approval_nonces: existing.applied_approval_nonces } : {}),
  };

  store.writeOwnerKey(passport.owner);
  store.writeVault(vault);
  return new Keyring(store);
}

/** Write the agent keypair into the cache (0600) so MCP/run can act as it. */
export function writeAgentKeypairFile(dir: string, passport: ParsedPassport): string {
  const keysDir = path.join(dir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const p = path.join(keysDir, `${passport.agentId.slice(0, 14)}-keypair.json`);
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        agent_id: passport.agentId,
        public_key_b58: base58Encode(passport.agent.publicKey),
        private_key_hex: bytesToHex(passport.agent.privateKey),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  return p;
}
