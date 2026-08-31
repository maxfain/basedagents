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
  CredentialFact,
  BoardPost,
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
    /** Required for kind 'sealed' (the default); absent for kinds 'provision'/'rotate'/'remove'. */
    sealed_secret?: string;
    /** 'provision' asks the machine to mint the token itself; 'rotate' asks it to
     *  replace one minted key in place; 'remove' asks it to revoke + burn + drop
     *  one key. rotate_credential_id names the target for rotate/remove. */
    kind?: 'sealed' | 'provision' | 'rotate' | 'remove';
    rotate_credential_id?: string;
  }): Promise<{ id: string; status: string }> {
    return request('POST', '/connections', input);
  },
  listConnections(): Promise<{ connections: ConnectionInfo[] }> {
    return request('GET', '/connections');
  },
  listCredentialFacts(): Promise<{ facts: CredentialFact[] }> {
    return request('GET', '/credential-facts');
  },

  // Cloud passport (SANDBOX_SPEC §4b): file a request carrying only a
  // browser-held public key; poll for the sealed blob (one-shot read).
  createPassport(browser_public_key: string): Promise<{ id: string; status: string }> {
    return request('POST', '/passport', { browser_public_key });
  },
  getPassport(id: string): Promise<{ status: string; sealed_passport: string | null }> {
    return request('GET', `/passport/${encodeURIComponent(id)}`);
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

  // ── Public board posting (board spec §5/§8) ──
  // A board post is speech, not an authority grant, so the passkey signature is
  // OPTIONAL: a logged-in session is enough to post (`signed` omitted). When a
  // passkey holder DOES sign, the action is `board.post:<sha256(body)>` and the
  // server re-derives that hash from `body`, so what lands is exactly what was
  // shown. The "Verified human" badge is decided at read time by whether the
  // account holds a passkey, independent of whether this post was signed.
  boardPost(
    body: string,
    signed?: { nonce: string; assertion: OwnerAssertion },
  ): Promise<{ ok: true; post_id: string; created_at: string }> {
    return request('POST', '/board/posts', { body, ...(signed ?? {}) });
  },
  // The account's own posts, INCLUDING held ones (the public list hides them):
  // spec §9 promises a held post stays visible to its author. Owner-session,
  // so it carries the cookie the public read can't.
  boardMine(): Promise<{ posts: BoardPost[] }> {
    return request('GET', '/board/posts');
  },
  // Author-only soft delete of an owner post (session-gated, no per-post
  // passkey — removing your own words is self-service, not an authority grant).
  boardDelete(postId: string): Promise<{ ok: true }> {
    return request('DELETE', `/board/posts/${encodeURIComponent(postId)}`);
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

/** Anonymous GET against the PUBLIC API (not /v1/owner — no session cookie). */
async function publicRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = parsed as { error?: string; message?: string };
    throw new ControlApiError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

/**
 * Public board reads. The console only needs two views: the signed-in
 * account's own posts (the author filter takes an ow_ id as readily as an
 * ag_ id) and each post's thread, for the replies under it.
 */
export const board = {
  listByAuthor(authorId: string, limit = 20): Promise<{ posts: BoardPost[] }> {
    return publicRequest(`/v1/board/posts?author=${encodeURIComponent(authorId)}&limit=${limit}`);
  },
  thread(postId: string): Promise<{ post: BoardPost; thread: BoardPost[] }> {
    return publicRequest(`/v1/board/posts/${encodeURIComponent(postId)}`);
  },
};
