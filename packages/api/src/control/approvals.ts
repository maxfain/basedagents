/**
 * Keyring grant-approval routes — owner console + daemon pull/confirm loop.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * This is increment 2b's control-plane half (CONTROL_PLANE.md §2, the grant flow):
 *
 *   Owner-facing (session to look, signature to act — §3):
 *     POST /requests               file a pending keyring_request (agent must be delegated)
 *     GET  /requests?status=       list the owner's requests
 *     POST /requests/:id/approve   the approve_grant ACTION — a fresh WebAuthn
 *                                  assertion over the grant-approval canonical
 *                                  (§2.1) that PINS the grantee pubkey; reuses the
 *                                  increment-1 ceremony {@link verifyAndRecordAction}
 *                                  verbatim, then queues a grant_approvals row.
 *     POST /requests/:id/deny      deny a pending request
 *
 *   Daemon-facing (the local vault daemon authenticates AS the owner via the
 *   owner's Ed25519 vault key — {@link daemonAuth}):
 *     GET  /daemon/approvals            pull pending_daemon approvals (shaped as
 *                                       keyring's GrantApproval so the daemon
 *                                       applies them directly)
 *     POST /daemon/approvals/:id/confirm  report the applied grant (or a failure)
 *
 * The console shows a grant `active` ONLY after the daemon confirms (§2 step 4):
 * a compromised control plane can delay or drop, but never forge or redirect a
 * grant — the daemon re-verifies the owner assertion against a locally-anchored
 * passkey before it seals.
 *
 * Mounted by the coordinator at /v1/owner (alongside ./routes.ts).
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import type { KeyringRequestRow, GrantApprovalRow } from './store.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import { grantApprovalCanonical, grantApprovalHash } from './grant-actions.js';
import type { GrantConstraints } from './grant-actions.js';
import {
  ownerSession,
  verifyAndRecordAction,
  AssertionSchema,
} from './routes.js';
import {
  base58Encode,
  base58Decode,
  sha256,
  bytesToHex,
  verifySignature,
} from '../crypto/index.js';
import { convertCOSEtoPKCS } from '@simplewebauthn/server/helpers';
import { rpConfig } from './config.js';

// ─── small helpers (kept local; mirror ./routes.ts conventions) ───

const textEncoder = new TextEncoder();

/** How far a daemon request timestamp may drift, in seconds (mirrors middleware/auth.ts). */
const DAEMON_CLOCK_SKEW_SECONDS = 15;

function getStore(c: Context<AppEnv>): ControlStore {
  return new ControlStore(c.get('db'));
}

function nowIso(): string {
  return new Date().toISOString();
}

// ownerId is a control-plane-only context var (kept OUT of the shared AppEnv
// Variables) — stash/read with a cast, same as ./routes.ts.
function setOwnerId(c: Context<AppEnv>, ownerId: string): void {
  (c.set as (k: string, v: unknown) => void)('ownerId', ownerId);
}
function getOwnerId(c: Context<AppEnv>): string {
  return (c.get as (k: string) => string)('ownerId');
}

function err(c: Context<AppEnv>, status: 400 | 401 | 404 | 409, error: string, message: string) {
  return c.json({ error, message }, status);
}

async function parseJson(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json();
}

function isUniqueViolation(e: unknown): boolean {
  const e2 = e as { message?: unknown; code?: unknown };
  const msg = typeof e2?.message === 'string' ? e2.message : '';
  const code = typeof e2?.code === 'string' ? e2.code : '';
  return msg.includes('UNIQUE constraint failed') || code.includes('SQLITE_CONSTRAINT');
}

/** Decode a standard base64 string to bytes (daemon signatures are base64). */
function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Keep only the four recognized constraint keys — the exact set the grant-approval
 * canonical serializes (CONTROL_PLANE.md §2.1). Dropping anything else means a
 * request cannot carry an unsigned constraint into the queued approval.
 */
function normalizeConstraints(c?: Partial<GrantConstraints> | null): GrantConstraints {
  const out: GrantConstraints = {};
  if (!c) return out;
  if (c.expires_at !== undefined) out.expires_at = c.expires_at;
  if (c.max_lease_ttl_seconds !== undefined) out.max_lease_ttl_seconds = c.max_lease_ttl_seconds;
  if (c.max_uses !== undefined) out.max_uses = c.max_uses;
  if (c.project !== undefined) out.project = c.project;
  return out;
}

function parseConstraints(json: string): GrantConstraints {
  try {
    return normalizeConstraints(JSON.parse(json) as Partial<GrantConstraints>);
  } catch {
    return {};
  }
}

// ─── response shaping ───

function requestResponse(r: KeyringRequestRow) {
  return {
    id: r.id,
    owner_id: r.owner_id,
    agent_id: r.agent_id,
    credential_id: r.credential_id,
    credential_label: r.credential_label,
    provider: r.provider,
    constraints: parseConstraints(r.constraints),
    note: r.note,
    status: r.status,
    created_at: r.created_at,
    decided_at: r.decided_at,
    decision_assertion_id: r.decision_assertion_id,
    deny_reason: r.deny_reason,
  };
}

/** Shape a queued approval as keyring's `GrantApproval` (+ id / pinned pubkey / hash). */
function approvalForDaemon(r: GrantApprovalRow) {
  return {
    id: r.id,
    nonce: r.nonce,
    credential_id: r.credential_id,
    agent_id: r.agent_id,
    agent_pubkey: r.agent_pubkey,
    action_hash: r.action_hash,
    constraints: parseConstraints(r.constraints),
    assertion: {
      credentialId: r.assertion_credential_id,
      authenticatorData: r.authenticator_data,
      clientDataJSON: r.client_data_json,
      signature: r.signature,
    },
  };
}

function approvalStatus(r: GrantApprovalRow) {
  return {
    approval_id: r.id,
    status: r.status,
    confirmed_at: r.confirmed_at,
    daemon_grant_id: r.daemon_grant_id,
    failure_reason: r.failure_reason,
  };
}

// ─── validation schemas ───

const ConstraintsSchema = z
  .object({
    expires_at: z.string().optional(),
    max_lease_ttl_seconds: z.number().optional(),
    max_uses: z.number().optional(),
    project: z.string().optional(),
  })
  .optional();

const CreateRequestSchema = z.object({
  agent_id: z.string().min(1),
  credential_id: z.string().min(1),
  credential_label: z.string().optional(),
  provider: z.string().optional(),
  constraints: ConstraintsSchema,
  note: z.string().optional(),
});

const ApproveSchema = z.object({
  nonce: z.string().min(1),
  assertion: AssertionSchema,
});

const DenySchema = z.object({ reason: z.string().optional() });

const ConfirmSchema = z
  .object({
    daemon_grant_id: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .refine((v) => !!v.daemon_grant_id || !!v.error, {
    message: 'daemon_grant_id or error required',
  });

// ─── daemonAuth ("the daemon acts as the owner via the Ed25519 vault key") ───

/**
 * Authenticate the local vault daemon AS the owner. The daemon signs, with the
 * owner's Ed25519 vault (confidentiality) key, the same canonical message the
 * AgentSig scheme uses (middleware/auth.ts):
 *
 *   "<METHOD>:<path>:<timestamp>:<sha256hex(body)>:<nonce?>"
 *
 * We verify that signature, derive owner_id = ownerIdFromVaultPubkey(pubkey), and
 * REQUIRE an active owner_vault_keys row that binds this exact vault key to that
 * owner (so a valid Ed25519 key that was never bound as a vault key cannot pull
 * approvals). On success c.get('ownerId') is the daemon's owner. 401 otherwise.
 */
export const daemonAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('AgentSig ')) {
    return err(c, 401, 'unauthorized', 'missing AgentSig authorization header');
  }
  const creds = authHeader.slice('AgentSig '.length);
  const colon = creds.indexOf(':');
  if (colon === -1) {
    return err(c, 401, 'unauthorized', 'malformed AgentSig header — expected <pubkey>:<signature>');
  }
  const b58PubKey = creds.slice(0, colon);
  const b64Signature = creds.slice(colon + 1);

  let publicKey: Uint8Array;
  try {
    publicKey = base58Decode(b58PubKey);
  } catch {
    return err(c, 401, 'unauthorized', 'invalid base58 public key');
  }
  if (publicKey.length !== 32) {
    return err(c, 401, 'unauthorized', 'invalid public key length');
  }

  const signature = base64ToBytes(b64Signature);
  if (!signature || signature.length !== 64) {
    return err(c, 401, 'unauthorized', 'invalid signature');
  }

  const timestamp = c.req.header('X-Timestamp');
  if (!timestamp) {
    return err(c, 401, 'unauthorized', 'missing X-Timestamp header');
  }
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > DAEMON_CLOCK_SKEW_SECONDS) {
    return err(c, 401, 'unauthorized', 'timestamp out of range');
  }

  // Reconstruct the signed message. Hono caches the body, so this read does not
  // interfere with the handler's later c.req.json() (see middleware/auth.ts MED-3).
  const body = await c.req.text();
  const bodyHash = bytesToHex(sha256(textEncoder.encode(body)));
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const nonce = c.req.header('X-Nonce');
  const message = nonce
    ? `${method}:${path}:${timestamp}:${bodyHash}:${nonce}`
    : `${method}:${path}:${timestamp}:${bodyHash}`;

  const valid = await verifySignature(textEncoder.encode(message), signature, publicKey);
  if (!valid) {
    return err(c, 401, 'unauthorized', 'invalid signature');
  }

  // The vault key must be an ACTIVE, bound vault key for the owner it derives.
  const ownerId = ownerIdFromVaultPubkey(publicKey);
  const store = getStore(c);
  const vaultKey = await store.getActiveVaultKey(ownerId);
  if (!vaultKey || vaultKey.vault_public_key !== base58Encode(publicKey)) {
    return err(c, 401, 'unauthorized', 'vault key is not bound to an owner');
  }

  setOwnerId(c, ownerId);
  await next();
};

// ─── the sub-app ───

const app = new Hono<AppEnv>();

// ── Owner: file a request ──

app.post('/requests', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = CreateRequestSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  // The grantee must be an agent the owner has an ACTIVE delegation for.
  const delegation = await store.getDelegation(ownerId, parsed.data.agent_id);
  if (!delegation || delegation.status !== 'active') {
    return err(c, 400, 'bad_request', 'agent is not delegated to this owner');
  }

  const request = await store.createKeyringRequest({
    ownerId,
    agentId: parsed.data.agent_id,
    credentialId: parsed.data.credential_id,
    credentialLabel: parsed.data.credential_label,
    provider: parsed.data.provider,
    constraints: normalizeConstraints(parsed.data.constraints),
    note: parsed.data.note,
  });
  return c.json(requestResponse(request));
});

// ── Owner: list requests ──

app.get('/requests', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const status = c.req.query('status');
  const store = getStore(c);
  const rows = await store.listKeyringRequests(ownerId, status);
  return c.json({ requests: rows.map(requestResponse) });
});

// ── Owner: approve a request (the approve_grant ACTION) ──

app.post('/requests/:id/approve', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const requestId = c.req.param('id');
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = ApproveSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const request = await store.getKeyringRequest(requestId);
  if (!request || request.owner_id !== ownerId) {
    return err(c, 404, 'not_found', 'request not found');
  }
  if (request.status !== 'pending') {
    return err(c, 400, 'bad_request', `request is already ${request.status}`);
  }

  // PIN the sealing target: the grantee's on-file Ed25519 pubkey (base58). The
  // daemon re-derives exactly this from the agent id before it seals (§2.1).
  const agentPub = await store.getAgentPublicKey(request.agent_id);
  if (!agentPub) {
    return err(c, 400, 'bad_request', 'grantee agent has no public key on file');
  }
  const agentPubkey = base58Encode(agentPub);
  const constraints = parseConstraints(request.constraints);

  // The canonical the owner passkey must have signed. Field set is identical to
  // /action/begin's for approve_grant ({action_type, owner_id, nonce, agent_id,
  // agent_pubkey, credential_id, constraints}), so the armed challenge matches.
  const statement = {
    owner_id: ownerId,
    nonce: parsed.data.nonce,
    agent_id: request.agent_id,
    agent_pubkey: agentPubkey,
    credential_id: request.credential_id,
    constraints,
  };
  const canonical = grantApprovalCanonical(statement);

  // The full ceremony: WYSIWYS + consume-first + verify + counter + chain-append.
  const outcome = await verifyAndRecordAction(c, ownerId, 'approve_grant', canonical, parsed.data.assertion);
  if (!outcome.ok) return outcome.res;

  const actionHash = grantApprovalHash(statement);
  let approval: GrantApprovalRow;
  try {
    approval = await store.createGrantApproval({
      ownerId,
      requestId,
      agentId: request.agent_id,
      agentPubkey,
      credentialId: request.credential_id,
      constraints,
      nonce: parsed.data.nonce,
      actionHash,
      assertionCredentialId: parsed.data.assertion.credentialId,
      authenticatorData: parsed.data.assertion.authenticatorData,
      clientDataJson: parsed.data.assertion.clientDataJSON,
      signature: parsed.data.assertion.signature,
      assertionId: outcome.row.id,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // The per-ceremony nonce is already tied to an approval — never queue twice.
      return err(c, 409, 'conflict', 'approval nonce already used');
    }
    throw e;
  }

  const decided = await store.setRequestDecision({
    id: requestId,
    status: 'approved',
    assertionId: outcome.row.id,
    nowIso: nowIso(),
  });
  return c.json({ request: requestResponse(decided), approval_id: approval.id });
});

// ── Owner: deny a request ──

app.post('/requests/:id/deny', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const requestId = c.req.param('id');
  let body: unknown = {};
  try {
    body = await parseJson(c);
  } catch {
    // deny body is optional — tolerate an empty/absent body.
  }
  const parsed = DenySchema.safeParse(body ?? {});
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const request = await store.getKeyringRequest(requestId);
  if (!request || request.owner_id !== ownerId) {
    return err(c, 404, 'not_found', 'request not found');
  }
  if (request.status !== 'pending') {
    return err(c, 400, 'bad_request', `request is already ${request.status}`);
  }

  const decided = await store.setRequestDecision({
    id: requestId,
    status: 'denied',
    denyReason: parsed.data.reason,
    nowIso: nowIso(),
  });
  return c.json(requestResponse(decided));
});

// ── Daemon: pull pending approvals ──

// ── Daemon: fetch the owner's registered passkeys (to anchor via `based link`) ──
//
// The daemon shows these to the owner and anchors on confirmation (CONTROL_PLANE
// §2: the anchor is trusted because the human confirms it, not because it was
// fetched). COSE keys are converted to the uncompressed P-256 point the daemon's
// verifier expects; rp_id + origins come from server config.
app.get('/daemon/passkeys', daemonAuth, async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const { rpId, origins } = rpConfig(c.env);
  const creds = await store.listCredentials(ownerId);
  return c.json({
    rp_id: rpId,
    origins,
    passkeys: creds.map((cr) => ({
      credential_id: cr.credential_id,
      public_key_hex: bytesToHex(Uint8Array.from(convertCOSEtoPKCS(Uint8Array.from(cr.public_key)))),
      nickname: cr.nickname ?? null,
      created_at: cr.created_at,
    })),
  });
});

app.get('/daemon/approvals', daemonAuth, async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const rows = await store.listPendingApprovals(ownerId);
  return c.json({ approvals: rows.map(approvalForDaemon) });
});

// ── Daemon: confirm (or report failure of) an approval ──

app.post('/daemon/approvals/:id/confirm', daemonAuth, async (c) => {
  const ownerId = getOwnerId(c);
  const approvalId = c.req.param('id');
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = ConfirmSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'daemon_grant_id or error required');

  const store = getStore(c);
  const approval = await store.getGrantApproval(approvalId);
  // Only the OWNING owner may confirm.
  if (!approval || approval.owner_id !== ownerId) {
    return err(c, 404, 'not_found', 'approval not found');
  }
  if (approval.status !== 'pending_daemon') {
    return err(c, 409, 'conflict', `approval is already ${approval.status}`);
  }

  const updated = parsed.data.daemon_grant_id
    ? await store.confirmGrantApproval({
        id: approvalId,
        daemonGrantId: parsed.data.daemon_grant_id,
        nowIso: nowIso(),
      })
    : await store.failGrantApproval({
        id: approvalId,
        reason: parsed.data.error!,
        nowIso: nowIso(),
      });

  if (!updated) {
    // Lost the race to another confirm/fail on the same pending row.
    return err(c, 409, 'conflict', 'approval is no longer pending');
  }
  return c.json(approvalStatus(updated));
});

export default app;
