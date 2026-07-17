# Keyring Control Plane — Architecture of Record

**Status:** Design locked · July 2026 · implements KEYRING_SPEC.md v0.2 §5
**Datastore decision:** Cloudflare Workers + D1 (one Worker, extend the existing
`agent-registry-api`). Supabase and a Neon hybrid were evaluated and rejected —
both split the owner→agent delegation edge across two stores (the exact edge the
feature adds) and neither implements the hard part (WebAuthn/passkey authority),
which is hand-built regardless. See `LICENSING.md` (control-plane code is
proprietary).

This document is the authority model. It exists because the naive version — "the
console verifies the owner and flips a `status=active` flag the daemon obeys" —
has a compromised-control-plane hole. The rules below close it.

---

## 1. Two owner keys, bound but distinct

"The passkey *is* the owner's root keypair" is a simplification. A WebAuthn
passkey is a non-exportable ES256/P-256 credential bound to an authenticator: it
cannot do X25519 ECDH for sealed boxes and cannot produce Ed25519 signatures. So
the owner has two keys:

| Key | Type | Lives | Role |
|---|---|---|---|
| **Authority key** | WebAuthn passkey (ES256) | the authenticator (phone/laptop) | Authorizes control-plane actions. The root of *authority*. |
| **Confidentiality key** | Ed25519 (→X25519) | `owner.json` in the local vault daemon | Seals/opens secrets. The `ow_` identity is derived from it. The root of *confidentiality*. Never leaves the machine, never touches the control plane. |

They are joined by an **owner binding**: the passkey signs a canonical statement
`{ owner_id, vault_ed25519_pub, purpose: "vault-binding", ts }`. The vault daemon
anchors the passkey public key(s) locally at binding time; the control plane
stores the binding as metadata only.

## 2. The daemon is the source of truth and the enforcement point

The control plane is a **hosted projection + request queue + auth surface**. It
is trusted for neither confidentiality nor authority:

- **Confidentiality:** no sealed box, ephemeral key, or plaintext ever occupies a
  D1 column. Sealing happens only in the daemon. (Structural.)
- **Authority:** the daemon **independently verifies the owner's WebAuthn
  assertion** over the *exact* action before it seals — it never acts on a
  control-plane status flag.

### The grant flow (the rule that closes the hole)

1. Agent asks (`keyring_request`) → control plane stores a **pending** request.
2. Owner approves in the console → the browser produces a **fresh WebAuthn
   assertion** whose challenge is `sha256(canonical_action)` where
   `canonical_action` **pins the grantee agent's public key**, the credential id,
   and the constraints — not just a request id.
3. The daemon pulls the approved request + assertion, and **re-verifies**:
   - the assertion signature against the **locally-anchored** owner passkey key
     (not a key it fetched from the control plane this session);
   - that the signed `canonical_action` names **the pubkey the daemon is about to
     seal to** (re-derived from the agent identity, not taken on trust);
   - challenge freshness / single-use.
   Only then does it re-seal the secret to the grantee.
4. The daemon reports the *confirmed* result back; the console shows `active`
   **only after** the daemon confirms — so the console can never show `active`
   for a grant the daemon didn't actually seal.

A fully-compromised control plane can therefore delay or drop a grant, but cannot
forge one, redirect its seal target, or read a secret. What-you-see-is-not-
what-you-sign is mitigated (not eliminated — a platform limit) by putting the
full action, including the grantee pubkey, inside the signed payload and having
the daemon re-derive and surface it.

### 2.1 Grant-approval action contract

Both sides must produce byte-identical canonical JSON or the hashes won't agree.
The single source of truth is `packages/keyring/src/control-actions.ts`
(`grantApprovalCanonical`); the control plane implements the matching side. The
statement the owner passkey signs is:

```
canonicalJson({
  action_type: "approve_grant",
  owner_id,          // the control-plane owner identity: "ow_" + base58(vault Ed25519 pubkey).
                     // Supplied by the DAEMON (which stores the same key as ag_ internally,
                     // but signs/verifies the CONTRACT with the ow_ form the console uses).
  nonce,             // server-issued, per-ceremony, single-use at the daemon
  agent_id,          // the grantee
  agent_pubkey,      // base58 Ed25519 — the pinned sealing target, DAEMON-derived from agent_id
  credential_id,
  constraints,       // only the set keys: expires_at, max_lease_ttl_seconds, max_uses, project
})
```

The WebAuthn challenge is `base64url(sha256(canonical))`. On apply, the daemon
recomputes this from its own `owner_id` and the grantee pubkey it is about to
seal to; any control-plane substitution of owner, grantee, credential, or
constraints changes the hash and the anchored-passkey assertion fails to verify.
`nonce` is recorded in the vault so a relayed approval is single-use daemon-side.

## 3. Sessions to look, signatures to act

- **Look:** a session cookie (httpOnly, `SameSite=Strict`) authorizes
  **read-only** console browsing. It can never mutate state. Since spec v0.2
  there are two rungs that mint one — an **email magic link** (the claim flow
  and `/login/email`) and a **passkey login** — and the session records its
  `method`. Both rungs look the same and stop at the same wall.
- **Act:** every mutating action (approve/revoke/kill/create-delegation) requires
  a **fresh WebAuthn assertion** bound to that action's hash. An email-rung
  session with no passkey on file arms **no usable challenge** (empty
  `allowCredentials`); the **first approval mints the passkey** (§8) and from
  then on nothing moves without its signature. Because a mutation always needs
  a fresh assertion, the write path is inherently CSRF-resistant; a stolen
  look-session grants browsing, not authority.

## 4. Integrity primitives (atomicity is not optional)

`DBAdapter` exposes only `get/all/run/exec` — no transactions. Security-critical
state changes must therefore be **single atomic conditional writes**, verified by
`.changes`, never TOCTOU SELECT-then-INSERT:

- **Single-use challenge:** `UPDATE webauthn_challenges SET consumed_at=?1 WHERE
  id=?2 AND consumed_at IS NULL` → require `changes === 1`. A replayed assertion
  loses the race.
- **Monotonic counter:** `UPDATE owner_webauthn_credentials SET signature_counter=?1,
  last_used_at=?3 WHERE id=?2 AND signature_counter < ?1` → require `changes === 1`
  (unless the authenticator reports 0, the no-counter case).
- **Delegation uniqueness:** `UNIQUE(owner_id, agent_id)` at the schema level.

## 5. Owner authority events are hash-chained

Owner actions (register, bind, delegate, approve, revoke, kill) are recorded as
**signed, hash-chained** events (`prev_hash`/`entry_hash`), the same tamper-
evident construction the agent access log already uses. A delegation/grant row
references the authorizing event; deleting or withholding that event breaks the
chain and is detectable. The authoritative chain is the daemon's `events.jsonl`;
the control plane keeps a verifiable mirror, not a second source of truth.

## 6. Recovery (semi-custodial authority, never secrets)

Email magic link + a hashed one-time recovery code authenticate a **passkey
rotation**: enroll a new passkey, then the daemon participates in a re-binding
ceremony that re-signs the vault binding and each active delegation under the new
authority. This makes *authority* semi-custodial; the Ed25519 confidentiality key
and all ciphertext are never touched by recovery. Because the control plane
authors the re-signing batch, the daemon must show and verify each item — same
WYSIWYS discipline as §2.

## 7. RP ID / origin

WebAuthn RP ID is scoped to the registrable domain `basedagents.ai` so passkeys
registered on `app.basedagents.ai` keep working across console subdomains.
Assertions verify `rpIdHash`, `origin` (allow-list), `type`, the server-issued
single-use challenge, and the User Present flag.

## 8. The authority ladder (spec v0.2 §5.1)

Anonymous → email → passkey. There is no signup form: `npx @basedagents/keyring
init` on the user's machine creates the vault + agent identity and a 30-minute
**link code**; the `/link` page claims it with one email field; the magic-link
click **ratifies** — in one idempotent, ordered sequence — the owner row (id
still derived from the vault Ed25519 key), the email verification, the vault-key
binding, and the delegation of the linking agent (`authorized_via='claim'`).
What that claim honestly rests on: possession of the email inbox **plus physical
control of the machine that ran `init`**.

The "physical control" half is not assumed — it is **proven**. The owner id is
`ow_<base58(vaultPub)>`, a *non-secret* identifier, so `POST /link` requires a
**vault-key signature** over `keyring-link:v1:<vaultPub>:<agentId>:<agentPub>`;
only the holder of the vault *private* key can mint a link code for that owner.
Without it, anyone who learned a victim's owner id could mint a code and claim
the account under their own email. As defence in depth, `/claim/finish` also
refuses to bind a **pre-existing** account to a different verified email, orders
every write so the single-use link is marked `claimed` **last** (a mid-sequence
failure leaves it re-runnable, never a false success), and is idempotent —
reactivating a revoked delegation rather than colliding on it. The passkey — still the sole authority root for acting — is
minted at the **first approval**, the first moment authority is exercised, and
the daemon still independently re-verifies every approval against locally
anchored passkeys before sealing (§2). Nothing in §§2–6 weakened.

Two adjacent flows share the machinery:

- **Agent-first entry.** A registered agent may `invite_owner(email)` (MCP).
  An invite is *not* an account: claim-pending holds authority over nothing,
  **structurally** — no owner row, no vault key, no delegation exist until a
  human claims a link code, which only `init` on the human's machine can mint.
  Invites expire in 72h, are capped per agent per day, and back off on re-send.
- **Connect cards.** The onboarding page's provider cards accept a pasted
  token, but the browser **seals it client-side** to the owner's vault key
  (the console imports the daemon's own sealed-box crypto — X25519 + HKDF +
  XChaCha20-Poly1305 — so parity is by construction). The control plane stores
  ciphertext only and blanks it once the daemon reports `stored`; the daemon
  opens it locally, validates against the provider, stores the credential and
  creates the grant. `init` keeps running after the claim precisely to catch
  these, so the base case never returns to the terminal.
- **The web door (`/start`).** "Get started" leads to a two-door page,
  terminal-primary: the paste-into-Claude-Code block, or one email field
  ("Start in your browser"). `POST /start/email` sends a magic link to *any*
  address (uniform text — no enumeration); `POST /start/finish` mints a look
  session for a **returning** account and, for a **first-time** visitor,
  returns `has_account:false` so the console shows the command to hand its
  agent. There is deliberately **no browser-side vault**: setup always happens
  where the agent lives, so the vault private key never enters a browser. The
  console's `/signup` 301s to `/start`.

---

## Scope & phasing

**Increment 1 (this milestone).** Owner identity (`ow_`), WebAuthn registration +
authentication verification on Workers, the atomic single-use-challenge and
monotonic-counter primitives, sessions-to-look + signatures-to-act guards, the
owner binding, and the owner→agent delegation edge — control-plane side, tested.

**Increment 2a (shipped).** Daemon-side (`packages/keyring`) owner-assertion
verification before sealing (§2 step 3): owner-passkey anchoring
(`anchorOwnerPasskey`), the ES256 assertion verifier (`webauthn-verify.ts`, pure
`@noble` — no library on the user's machine), the shared grant-approval contract
(§2.1), and `applyApprovedGrant` — which re-derives the action hash and rejects
redirected seal targets, tampered constraints, unanchored passkeys, and replays.
Tested, including the redirect attack §2 exists to stop.

**Increment 2b (shipped).** The full approval loop, end to end:
- Control plane: `keyring_requests` (approvals inbox) + `grant_approvals`, the
  `approve_grant` action (produces the assertion the daemon consumes), and
  daemon-facing `GET /daemon/passkeys`, `GET /daemon/approvals`,
  `POST /daemon/approvals/:id/confirm` — authenticated by the owner's Ed25519
  vault key (`daemonAuth`, verified against an active `owner_vault_keys` binding).
- Daemon (`packages/keyring` CLI): `based link` anchors the console passkey(s)
  after the owner confirms the fingerprints; `based sync [--watch]` pulls approved
  grants, runs each through `applyApprovedGrant` (re-verify + re-seal), and
  confirms back — so the console shows `active` only on daemon confirmation.
An interop test drives the console-produced approval through the daemon's
`applyApprovedGrant`; the grant goes active and the grantee leases the secret.

**Increment 3a (shipped).** The owner console — a new proprietary package
`packages/console` (Vite + React, `app.basedagents.ai`), kept separate from the
open public site (`packages/web`) so no open code is relicensed:
- Passkey **sign-up / sign-in** ("sessions to look" §3): register binds a passkey
  to the `ow_` identity derived from the vault key; login mints the read-only
  session cookie. Browser WebAuthn plumbing (`lib/webauthn.ts`) is the tested,
  byte-exact base64url bridge to what the control plane verifies.
- The **approvals inbox** ("signatures to act" §3): the server arms the exact
  challenge from the request's own stored data via a new
  `POST /requests/:id/approve/begin` (so the browser never reconstructs the
  §2.1 canonical and can't get the pinned pubkey or constraints wrong); the
  console **re-hashes the returned canonical and refuses to sign unless it equals
  the challenge** — client-side WYSIWYS — then runs the passkey assertion and
  posts it to `/approve`. A grant is shown `active` only after the daemon
  confirms; the console can queue an approval but never seals a secret.

**Increment 3b (shipped).** Delegations + vault-binding screens, built on a
shared console-side action ceremony (`lib/ceremony.ts`): every mutation runs
`/action/begin` → **client-side WYSIWYS** → passkey assertion. The WYSIWYS step
is stronger than hash parity alone — it parses the server's canonical and
requires it to say *exactly* what the console asked for (action type, the
signed-in owner, the ceremony nonce, byte-identical params), refusing to sign
otherwise. For actions with no daemon re-verification (delegations, vault
binding) this check is the only thing standing between a compromised control
plane and the owner's passkey signing a swapped action — tested against
swapped-params / swapped-type / smuggled-field / wrong-owner canonicals.
- **Agents**: create (`create_delegation`) and revoke (`revoke_delegation`)
  owner→agent edges.
- **Vault**: `bind_vault_key` over the key derived from the signed-in owner id
  itself (nothing to type or mistype) — the step that unlocks `daemonAuth` for
  `based sync`; passkey list + daemon instructions. `GET /me` now reports the
  active vault-key binding.

**Increment 3c (shipped).** Recovery (§6) — authority rotation, never secrets.
Two factors, both required, neither sufficient alone: the emailed magic-link
token (mailbox; sha256-stored, 15-min TTL, single-use, fragment-carried so it
never hits server logs) and the offline recovery code (possession; issued to a
signed-in owner via its own passkey ceremony, shown exactly once, sha256-stored,
superseded by regeneration). `/recover/finish` consumes the WebAuthn challenge,
verifies the new passkey enrollment, atomically consumes both factors, then
revokes every other passkey and every live session. The Ed25519 vault key,
binding, and ciphertext are untouched — `daemonAuth` keeps working; the daemon's
passkey anchor goes stale by design and the owner re-runs `based link` (§2: the
anchor is trusted because the human confirms it). Anti-enumeration on
`/recover/begin` (uniform response), uniform 401s elsewhere, per-IP rate limits
on all three endpoints. Email is provider-pluggable (Resend if RESEND_API_KEY
is set; log-only sender otherwise). Console: recovery-code panel on Vault
(display-once) + the public `/recover` page.

**Increment 3d (shipped).** Billing — "local is free, hosted is paid"
(pricing locked Jul 2026): Free = 1 owner / 3 delegated agents / 30-day
retention; Pro $10/mo or $96/yr = unlimited agents / 1-year retention /
anomaly flags. `getEntitlements` (control/entitlements.ts) is the single
source of truth; enforcement at exactly two points — delegation creation and
grant approval — never at lease time, never on daemon endpoints; security
actions (revoke, kill switch) are never paywalled and verified un-gated on
past_due/canceled/over-limit accounts. Stripe Checkout + Customer Portal;
the signature-verified, event-id-idempotent webhook is the only writer of
plan state. Retention enforced at query time.

**v0.1 closeout (shipped).** Passkey E2E — Playwright + CDP virtual
authenticator, five scenarios against the real control plane and console,
including crypto verification of the stored approval assertion via keyring's
own `verifyOwnerAssertion` and the recovery rotation. Deploy automation —
merge-to-main applies D1 migrations, deploys the Worker, and publishes the
console; PRs get preview deploys; one-time setup in
`scripts/bootstrap-deploy.md`.

**Increment 4 (shipped).** The authority ladder + onboarding redesign (§8,
spec v0.2 §5.1). Migration `0027`: `link_codes`, `magic_link_tokens` (sha256-
stored, fragment-carried, single-use via atomic consume), `owner_invites`,
`pending_connections`, `owner_sessions.method`, and the `delegations` rebuild
(`authorized_via`, nullable authorizing assertion). Routes (`control/ladder.ts`):
link create/status/claim, `/claim/finish` (the ratifying moment), email login,
agent invites with abuse brakes, sealed connections (owner-, daemon-facing).
CLI: `init` is the whole onboarding — vault + auto-named agent + MCP config
(with permission) + ONE browser page, then stays alive storing connect-card
tokens; `invite_owner` MCP tool. Console: `/link`, `/claim`, `/welcome`
(connect cards), `/invited`, the novice home (`/home`, kill switch; full
console behind "Advanced"), email-first `/login`, command-not-form `/signup`,
and the first-approval passkey mint (`lib/approve.ts`). A banned-words lint
(`scripts/lint-ui-words.mjs`, AST-based, in `npm run lint`) keeps
grant/lease/delegation/identity/credential/owner off every base-case surface.
Marketing: `/keyring` is a static HTML page (readable with JS disabled,
Product+FAQ schema, self-canonical) with the paste-command hero and the
provider grid; anonymous funnel counters + vote tiles land in migration `0028`
(`/v1/funnel`, `/v1/providers/*/vote` — no identity stored, CLI pings are
opt-out via `BASEDAGENTS_NO_TELEMETRY=1`). E2E rewritten to the v0.2 brief:
claim → look-only; both login rungs; first-approval mint with crypto
verification of the stored assertion against the just-minted key; recovery;
aborted-creation negative.

**Deliberately deferred / not built as a hosted firehose.** The high-volume
AccessEvent stream is **not** mirrored wholesale into D1 (that would drag in
Queues + R2 + a pruning cron to prop up a table whose source of truth is the
daemon's `events.jsonl`). The console timeline queries the daemon on demand, with
at most a small recent-window cache. Revisit only if hosted analytics demand it.
