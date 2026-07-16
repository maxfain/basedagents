/**
 * Control-plane HTTP client for the owner console.
 *
 * Every request rides the httpOnly `SameSite=Strict` session cookie
 * (`credentials: 'include'`) — the "session to look" (CONTROL_PLANE.md §3).
 * Mutations additionally carry a fresh WebAuthn assertion in the body
 * ("signature to act"); this client never holds a token or a secret.
 */
import type {
  RegistrationOptionsResponse,
  LoginOptionsResponse,
  OwnerMe,
  KeyringRequest,
  ActionBeginResponse,
  ApproveBeginResponse,
  OwnerAssertion,
  Delegation,
  VaultKeyBinding,
} from './types.js';
import type { RegistrationResult } from '../lib/webauthn.js';

export const API_BASE = import.meta.env.VITE_API_URL || 'https://api.basedagents.ai';
const OWNER = `${API_BASE}/v1/owner`;

export class ControlApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OWNER}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = parsed as { error?: string; message?: string };
    throw new ControlApiError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

export const control = {
  // ── Registration (bind a passkey to the owner id derived from the vault key) ──
  registerBegin(vaultPublicKey: string, email?: string): Promise<RegistrationOptionsResponse> {
    return request('POST', '/register/begin', { vault_public_key: vaultPublicKey, email });
  },
  registerFinish(
    vaultPublicKey: string,
    reg: RegistrationResult,
  ): Promise<{ owner_id: string; credential_id: string }> {
    return request('POST', '/register/finish', {
      vault_public_key: vaultPublicKey,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
      transports: reg.transports,
    });
  },

  // ── Login ("session to look") ──
  loginBegin(ref: { owner_id?: string; email?: string }): Promise<LoginOptionsResponse> {
    return request('POST', '/login/begin', ref);
  },
  loginFinish(assertion: OwnerAssertion): Promise<{ owner_id: string }> {
    return request('POST', '/login/finish', assertion);
  },
  logout(): Promise<{ ok: true }> {
    return request('POST', '/logout');
  },

  // ── Reads ──
  me(): Promise<OwnerMe> {
    return request('GET', '/me');
  },
  listRequests(status?: string): Promise<{ requests: KeyringRequest[] }> {
    return request('GET', `/requests${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  },

  // ── Generic action ceremony ("signature to act") ──
  actionBegin(actionType: string, params: Record<string, unknown>): Promise<ActionBeginResponse> {
    return request('POST', '/action/begin', { action_type: actionType, params });
  },

  // ── Delegations (owner → agent edges) ──
  createDelegation(
    agentId: string,
    label: string | null,
    nonce: string,
    assertion: OwnerAssertion,
  ): Promise<Delegation> {
    // The canonical uses `label ?? null`, but the endpoint's schema wants the
    // field ABSENT (not null) when there is no label — omit it.
    return request('POST', '/delegations', {
      agent_id: agentId,
      ...(label !== null ? { label } : {}),
      nonce,
      assertion,
    });
  },
  revokeDelegation(delegationId: string, nonce: string, assertion: OwnerAssertion): Promise<Delegation> {
    return request('POST', `/delegations/${encodeURIComponent(delegationId)}/revoke`, { nonce, assertion });
  },

  // ── Vault-key binding (unlocks daemonAuth for `based sync`) ──
  bindVaultKey(vaultPublicKey: string, nonce: string, assertion: OwnerAssertion): Promise<VaultKeyBinding> {
    return request('POST', '/vault-binding', { vault_public_key: vaultPublicKey, nonce, assertion });
  },

  // ── Approve ceremony ("signature to act") ──
  approveBegin(requestId: string): Promise<ApproveBeginResponse> {
    return request('POST', `/requests/${encodeURIComponent(requestId)}/approve/begin`);
  },
  approve(
    requestId: string,
    nonce: string,
    assertion: OwnerAssertion,
  ): Promise<{ request: KeyringRequest; approval_id: string }> {
    return request('POST', `/requests/${encodeURIComponent(requestId)}/approve`, { nonce, assertion });
  },
  deny(requestId: string, reason?: string): Promise<KeyringRequest> {
    return request('POST', `/requests/${encodeURIComponent(requestId)}/deny`, { reason });
  },
};
