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
  RecoverOptionsResponse,
  RecoverFinishResponse,
  BillingInfo,
  LinkInfo,
  ClaimResult,
  ConnectionInfo,
} from './types.js';
import type { RegistrationResult } from '../lib/webauthn.js';

// VITE_API_URL='' (empty, set — dev/E2E) means same-origin relative requests,
// served through the vite proxy; unset means the production API.
export const API_BASE = import.meta.env.VITE_API_URL ?? 'https://api.basedagents.ai';
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

  // ── Authority ladder / onboarding ──
  linkStatus(code: string): Promise<LinkInfo> {
    return request('GET', `/link/${encodeURIComponent(code)}`);
  },
  /** Omit `email` to send to the start-code-attached address on the link. */
  linkClaim(code: string, email?: string): Promise<{ ok: true }> {
    return request('POST', `/link/${encodeURIComponent(code)}/claim`, email ? { email } : {});
  },
  claimFinish(token: string): Promise<ClaimResult> {
    return request('POST', '/claim/finish', { token });
  },
  loginEmail(email: string): Promise<{ ok: true }> {
    return request('POST', '/login/email', { email });
  },
  loginEmailFinish(token: string): Promise<{ owner_id: string }> {
    return request('POST', '/login/email/finish', { token });
  },
  startEmail(email: string): Promise<{ ok: true }> {
    return request('POST', '/start/email', { email });
  },
  startFinish(token: string): Promise<{ has_account: boolean; start_code?: string }> {
    return request('POST', '/start/finish', { token });
  },
  inviteClaim(token: string): Promise<{ ok: true; email: string; next_step: string }> {
    return request('POST', '/invites/claim', { token });
  },
  createConnection(input: {
    agent_id: string; provider: string; label?: string; env_var?: string;
    /** Required for kind 'sealed' (the default); absent for kind 'provision'. */
    sealed_secret?: string;
    /** 'provision' asks the machine where the agent lives to mint the token itself. */
    kind?: 'sealed' | 'provision';
  }): Promise<{ id: string; status: string }> {
    return request('POST', '/connections', input);
  },
  listConnections(): Promise<{ connections: ConnectionInfo[] }> {
    return request('GET', '/connections');
  },

  // ── Billing ("local is free, hosted is paid") ──
  getBilling(): Promise<BillingInfo> {
    return request('GET', '/billing');
  },
  billingCheckout(interval: 'monthly' | 'yearly'): Promise<{ url: string }> {
    return request('POST', '/billing/checkout', { interval });
  },
  billingPortal(): Promise<{ url: string }> {
    return request('POST', '/billing/portal');
  },

  // ── Recovery (CONTROL_PLANE.md §6) ──
  generateRecoveryCode(nonce: string, assertion: OwnerAssertion): Promise<{ recovery_code: string; created_at: string }> {
    return request('POST', '/recovery-code', { nonce, assertion });
  },
  recoverBegin(email: string): Promise<{ ok: true }> {
    return request('POST', '/recover/begin', { email });
  },
  recoverOptions(token: string, recoveryCode: string): Promise<RecoverOptionsResponse> {
    return request('POST', '/recover/options', { token, recovery_code: recoveryCode });
  },
  recoverFinish(
    token: string,
    recoveryCode: string,
    reg: RegistrationResult,
  ): Promise<RecoverFinishResponse> {
    return request('POST', '/recover/finish', {
      token,
      recovery_code: recoveryCode,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
      transports: reg.transports,
    });
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
