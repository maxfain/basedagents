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
  owner_id,          // the vault owner id — supplied by the DAEMON, not the approval
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

- **Look:** passkey login mints an httpOnly, `SameSite=Strict` session cookie.
  It authorizes **read-only** console browsing. It can never mutate state.
- **Act:** every mutating action (approve/revoke/kill/create-delegation) requires
  a **fresh WebAuthn assertion** bound to that action's hash. Because a mutation
  always needs a fresh assertion, the write path is inherently CSRF-resistant; a
  stolen look-session grants browsing, not authority.

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

**Increment 2b.** The control-plane `approve_grant` action endpoint (produces the
assertion the daemon consumes) + `keyring_requests`/`grants_meta` tables, and the
daemon HTTP pull/confirm loop (`based link` to anchor, a sync that pulls approved
requests, applies them locally, and confirms back); the console surfaces `active`
only on daemon confirmation.

**Increment 3.** Console UI (React screens), recovery flow, billing.

**Deliberately deferred / not built as a hosted firehose.** The high-volume
AccessEvent stream is **not** mirrored wholesale into D1 (that would drag in
Queues + R2 + a pruning cron to prop up a table whose source of truth is the
daemon's `events.jsonl`). The console timeline queries the daemon on demand, with
at most a small recent-window cache. Revisit only if hosted analytics demand it.
