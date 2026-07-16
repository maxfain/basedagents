# BasedAgents Keyring — Specification

**Status:** v0.1 shipped · July 2026. The v0.2 **hosted control plane** (owner
accounts, passkey authority, remote approvals, recovery) has since shipped —
its architecture of record is [`CONTROL_PLANE.md`](./CONTROL_PLANE.md); §5
below describes the v0.1 local admin plane it extends.
**One-liner:** Scoped, revocable credentials bound to cryptographic agent identities.
**Package:** [`@basedagents/keyring`](./packages/keyring) (npm) · CLI `based` · MCP server `basedagents-keyring-mcp`

---

## Table of Contents

- [1. Why this belongs inside BasedAgents](#1-why-this-belongs-inside-basedagents)
- [2. The problem, concretely](#2-the-problem-concretely)
- [3. Object model](#3-object-model)
- [4. Runtime delivery](#4-runtime-delivery)
- [5. Admin control plane](#5-admin-control-plane)
- [6. The Provisioner (v0.2 — not in this release)](#6-the-provisioner-v02--not-in-this-release)
- [7. Revocation semantics (the honest section)](#7-revocation-semantics-the-honest-section)
- [8. Threat model](#8-threat-model)
- [9. Cutlines](#9-cutlines)
- [10. Metrics](#10-metrics)
- [11. Open questions](#11-open-questions)
- [12. v0.1 implementation notes](#12-v01-implementation-notes)

---

## 1. Why this belongs inside BasedAgents

BasedAgents answers *who is this agent* (a registered keypair with a verifiable identity). Keyring answers the question that immediately follows: *what is this agent allowed to hold?*

Standalone secret vaults (1Password, Vault, Infisical) treat the agent as an opaque consumer — a token shows up, a secret goes out. Because BasedAgents already gives every agent a cryptographic identity, Keyring can do something they structurally can't: make every credential access a **signed, attributable event**. The agent proves who it is with its private key every time it requests a secret. Revocation, audit, and blast-radius analysis all fall out of the identity layer for free.

Positioning sentence: *"Your agents already have identities. Keyring is what those identities are trusted to carry."*

This also completes the portfolio thesis: BasedAgents = identity, Keyring = credentials, Looptail = the signed audit trail those access events feed into.

## 2. The problem, concretely

A builder running Claude Code / Codex across a typical indie stack (Vercel + Supabase + Railway + Neon + Stripe + GitHub) hits three recurring failures:

1. **Provisioning friction.** Every new project means logging into five dashboards to mint keys, then pasting them into `.env` files.
2. **Sprawl and zero visibility.** Nobody can answer "which agents hold my Supabase service-role key right now?"
3. **Revocation is fiction.** Deleting a key from a `.env` file does nothing; the real key lives on at the provider until someone rotates it — which means five more dashboard logins.

Enterprise NHI tools solve this for security teams. Nobody solves it for the individual builder whose "workforce" is four coding agents.

## 3. Object model

Field names below match the implemented types in [`packages/keyring/src/types.ts`](./packages/keyring/src/types.ts).

| Object | Description |
|---|---|
| **Identity** | Exists today in BasedAgents: an Ed25519 keypair, `ag_`-prefixed agent ID (the ID encodes the base58 public key). Keyring adds no new identity concepts. The vault tracks `KnownIdentity { agent_id, name?, keypair_path?, added_at }` — a friendly local name and an optional path to the agent's keypair file. Private key material never enters the vault. |
| **Credential** | Encrypted secret material + metadata: `{ credential_id, label, provider?, env_var?, scope?, rotation_policy?, provider_key_id?, created_at, updated_at, sealed }`. `sealed` maps `agent_id → base64 sealed box` — the owner's copy plus one per identity with an active grant. This is the only place secret material exists, and it is always ciphertext. |
| **Grant** | The binding `(identity, credential, constraints)`: `{ grant_id, agent_id, credential_id, constraints, status, use_count, created_at, revoked_at?, revoke_reason? }`. Constraints: `expires_at` (ISO expiry), `max_lease_ttl_seconds`, `max_uses` (usage cap), `project` (tag). Grants are what the owner creates and revokes. |
| **GrantRequest** | An agent-initiated ask, pending owner approval: `{ request_id, agent_id, provider, scope?, note?, status }` where status is `pending | approved | denied`. |
| **Lease** | A short-lived delivery of the secret to a running agent: `{ lease_id, credential, grant_id, agent_id, value, ttl_seconds, issued_at, expires_at, access_event_id }`. Default TTL 900 seconds (15 minutes), clamped to the grant's `max_lease_ttl_seconds`. The value is in-memory only, never written to disk. Every lease requires a signature from the agent's key. |
| **AccessEvent** | Append-only signed record: `{ agent_pubkey, agent_signature, signed_payload, credential_id, grant_id, timestamp, requesting_context, prev_hash, entry_hash, … }`. Hash-chained and independently verifiable; exportable as a Looptail-compatible signed artifact. Full envelope in [§12](#12-v01-implementation-notes). |

Core invariant: **secrets are encrypted client-side to the owner's key and to the public keys of granted identities** (sealed-box model). The store — local file today, hosted server in v0.3 — holds ciphertext only and can never read secrets. Granting opens the owner's sealed copy and re-seals to the grantee's public key. Revoking a grant blocks new leases and deletes the identity's sealed copy; updating a secret re-seals to the owner and every active grantee.

## 4. Runtime delivery

Three delivery surfaces, all backed by the same lease API:

**MCP server (primary).** `basedagents-keyring-mcp` (also `based mcp`) ships as an MCP server so it works in Claude Code, Claude Desktop, Codex, and Cursor with one config line. Tools exposed:

- `keyring_list()` — credentials this agent's identity has grants for (labels and metadata only, never values)
- `keyring_lease(ref, context?, ttl_seconds?)` — verifies the grant, signs an AccessEvent, returns the secret with TTL metadata and the signed access event ID
- `keyring_request(provider, scope?, note?)` — creates a pending grant request for the owner to approve
- `keyring_whoami()` — the agent identity this server is acting as

The agent's keypair comes from `BASEDAGENTS_KEYPAIR_PATH` (JSON, either `{ public_key_b58, private_key_hex }` or `{ publicKey, privateKey }` hex) or from `BASEDAGENTS_PRIVATE_KEY_HEX` + `BASEDAGENTS_PUBLIC_KEY_B58`. The vault directory comes from `BASEDAGENTS_KEYRING_DIR`.

**CLI (env injection).** `based run --agent ci-bot -- npm run deploy` leases every granted credential and injects them as env vars into the child process. Nothing touches disk; leases die with the process or their TTL, whichever comes first. This is the Doppler/Infisical ergonomic, but identity-bound and signed.

**SDK.** The TypeScript core library `@basedagents/keyring` *is* the v0.1 SDK: the `Keyring` class exposes init/open, grants, leases (`lease`, `leaseAll`), requests, views, and log verification/export for long-running programmatic agents. A Python client is future work.

Design rule: **the agent never sees more than it leased, and never for longer than the TTL.** Prompt-injection blast radius is one scoped key for fifteen minutes, with a signed record of the access.

## 5. Admin control plane

> **Update (July 2026):** the hosted half of this section shipped. Owner
> accounts with WebAuthn passkey authority, the remote approvals inbox
> (`app.basedagents.ai`), owner→agent delegations, vault-key binding,
> `based link` / `based sync` on the daemon side, and account recovery are
> implemented — see [`CONTROL_PLANE.md`](./CONTROL_PLANE.md) for the authority
> model (the daemon independently re-verifies every console approval against a
> locally anchored passkey before sealing; the control plane is never trusted
> for authority or confidentiality). Mobile push approvals and billing remain
> pending. The local admin plane below still works standalone.

The 1Password-style piece, but agent-first. In v0.1 this is a local, localhost-only web server started with `based admin` — token-authenticated, no remote access. Four tabs:

- **Agents.** Every identity, its grants, last access time, access-frequency sparkline (14 days). One **kill switch** per agent: revokes all its grants instantly — no new leases, sealed copies deleted. Provider-side burns are v0.2 (§6).
- **Credentials.** The reverse index: for any key, which identities hold grants, each holder's constraints, use count, and last lease time.
- **Timeline.** The AccessEvent stream, filterable by agent/credential/event type/project/time range. Export as signed JSON (Looptail ingestion format, §12) via the export button.
- **Approvals.** Pending `keyring_request`s from agents, approvable against an existing credential or deniable with a reason. Mobile push approvals are v0.3.

## 6. The Provisioner (v0.2 — not in this release)

> **Status: not shipped.** Nothing in v0.1 talks to a provider. This section is the design for v0.2.

The onboarding piece nobody else has productized: Keyring can **mint, rotate, and burn keys at the provider itself**, so revocation is real rather than cosmetic.

**Mechanism.** Runs against the *user's own authenticated browser session* — either a companion extension or a CDP attach to the user's local Chrome. Always user-initiated, always visible (no headless background credential harvesting). This is the defensible framing: a user automating their own account, equivalent to them clicking the buttons.

**Recipes.** Each provider gets a versioned recipe with four verbs:

- `mint(scope)` — create a key, named with the convention `ba/{agent}/{grant-id}` so it's identifiable in the provider's own dashboard
- `capture` — pull the value into Keyring at creation time (never displayed to the human)
- `rotate` — mint replacement, swap grants, burn old
- `burn` — delete/disable the key at the provider

**API-first rule.** Where a provider has a real key-management API (AWS IAM, GitHub fine-grained PATs, Stripe restricted keys), the recipe uses the API. The browser path is the fallback for the long tail of dashboard-only providers (Supabase, Railway, and most indie SaaS). This matters strategically: as providers ship native agent-credential APIs, recipes migrate transparently and the product doesn't die with the browser hack.

**Recipe library is open source.** Community-contributed recipes, signed and sandboxed (a recipe can only navigate its declared domains, can only write captured values into Keyring, never read existing ones). Coverage of the long tail becomes the moat. The `provider_key_id` field on credentials exists today so v0.2 burns have something to target.

## 7. Revocation semantics (the honest section)

Two distinct operations, and the UI must never conflate them:

1. **Revoke grant** (instant, always works): the identity can obtain no new leases. In v0.1 local mode, revocation also **deletes the identity's sealed copy of the secret from the vault file** — the secret cannot be re-obtained even by reading `vault.json` directly, because the remaining ciphertext is sealed only to keys the identity does not hold. Any outstanding lease expires within its TTL (≤ 15 min by default).
2. **Burn key** (closes the loop): the underlying provider key is rotated or deleted via the Provisioner. **The Provisioner is v0.2 — in v0.1, burning is manual.** Until you rotate the key at the provider, a long-lived key that already leaked exists at the provider.

Default posture to minimize the gap: prefer short-lived / scoped provider keys wherever the provider supports them, so a leaked secret dies on its own. The kill switch (`based kill <agent>`) executes the revoke side immediately across every grant the identity holds; in v0.2 it will also queue provider-side burns and show progress per credential ("3 of 5 keys burned, Railway pending — open browser to complete").

This candor is a feature. Every vault competitor implies revocation is instant; being explicit about lease TTL + burn is what makes security-literate builders trust the product.

## 8. Threat model

| Threat | Mitigation |
|---|---|
| Prompt-injected agent exfiltrates a secret | Scoped key, ≤ 15 min lease, signed AccessEvent identifies exactly which agent/when; kill switch (+ burn in v0.2) |
| Vault file read by another local process/user | Ciphertext only; sealed boxes open only with the owner's or a grantee's private key; files mode 0600, directory 0700 |
| Keyring server compromise (hosted mode, v0.3) | Ciphertext only; server holds no decryption capability |
| Malicious/compromised recipe (v0.2) | Recipes signed, domain-sandboxed, write-only into vault, human-visible execution |
| Stolen agent private key | Same as any BasedAgents identity compromise: owner revokes the identity's grants (kill switch); sealed copies deleted, no new leases |
| Tampered access log | Per-event Ed25519 signatures bind each event's chain position (`sequence` + `prev_hash`), its concrete `event_type`, and the vault id, over a sha256 hash chain; `based verify-log` detects edits, reordering, duplication, relabeling, and cross-vault splicing. Trailing deletion (truncation) is detected via the local `head.json` anchor and, definitively, by cross-checking a retained signed export used as an external anchor. Full offline proof against truncation requires keeping a signed export — a local attacker with write access could also rewrite the anchor — so deletion is made detectable, not impossible. |
| Owner device compromise | Out of scope — equivalent to master-password compromise in any vault. `owner.json` holds the owner's private key |

## 9. Cutlines

**v0.1 — Local-first vault — SHIPPED (July 2026)**

What shipped, exactly:

- `@basedagents/keyring` 0.1.0 on npm: the `Keyring` core library (the v0.1 SDK)
- Encrypted local store: sealed-box vault at `~/.basedagents/keyring`, ciphertext only (§12)
- Identity-bound grants with constraints: expiry, max lease TTL, usage caps, project tags
- Leasing via MCP server (`basedagents-keyring-mcp`) and CLI env injection (`based run`); default lease TTL 900 s, in-memory only
- Append-only signed AccessEvent log: Ed25519 signature per event, sha256 hash chain, `based verify-log`, signed export (`basedagents-keyring-log/v1`, Looptail-compatible)
- Grant requests + approvals (`keyring_request` → `based approve`/`deny` or the admin UI)
- Kill switch per agent (vault-side revoke of all grants)
- Local admin UI (`based admin`): Agents / Credentials / Timeline / Approvals
- Keys added by manual paste (`based add`). No Provisioner.

*Success = a Claude Code session that never sees a raw `.env`.*

**v0.2 — Provisioner alpha**
Five recipes: Vercel, Supabase, Railway, Neon, GitHub PAT. Mint + capture + burn. Kill switch wired to burns.

**v0.3 — Hosted + shared**
Hosted ciphertext sync, approvals inbox with mobile push, rotate recipes, OAuth refresh-token management, Looptail export integration, team grants (two humans, shared agent fleet).

**Non-goals:** human password management, SSO/SCIM, enterprise NHI governance/discovery (1Password/Aembit territory), being an MCP gateway.

## 10. Metrics

- Time-to-first-scoped-key for a new project (target: < 2 min vs ~20 min of dashboard hopping)
- % of agent runs using leases vs. raw env vars (adoption depth)
- Median revoke→burn completion time (measurable once v0.2 ships)
- Recipe coverage: # providers with working mint/burn (v0.2)

## 11. Open questions

1. **Local-first vs hosted default?** v0.1 answered this: local-first, which fits the BasedAgents ethos and kills the trust objection. Hosted encrypted sync remains optional (v0.3) for mobile approvals and teams.
2. **Provisioner form factor:** extension (easier session access, store-review risk) vs CDP-attach to local Chrome (no store, more setup). Prototype both against Supabase, pick by friction.
3. **Monetization:** free local single-user; paid for hosted sync, teams, and burn automation? Or is Keyring purely the wedge that makes BasedAgents identity registration the paid layer?
4. **Naming check:** "Keyring" — trademark scan needed (GNOME Keyring exists as OSS but different market; likely fine as a feature name under the BasedAgents mark, not a standalone brand).

## 12. v0.1 implementation notes

What is actually on disk and on the wire in the shipped release. Source of truth: [`packages/keyring/src`](./packages/keyring/src).

### Sealed-box construction (versioned, v1)

Secrets are sealed to Ed25519 identity keys — the same keys agents register with. Construction:

```
recipient X25519 pub  = edwardsToMontgomery(Ed25519 pub)
ephemeral keypair     = fresh X25519 pair per encryption
shared                = x25519(ephemeral priv, recipient X25519 pub)
key                   = HKDF-SHA256(shared,
                          salt = ephPub ‖ recipPub,
                          info = "basedagents-keyring/v1/sealed-box", 32 bytes)
box                   = 0x01 ‖ ephPub(32) ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, plaintext)
```

The leading version byte is `0x01`; unknown versions are rejected on open. Boxes are stored base64 in `vault.json`. Anyone can seal; only the holder of the matching Ed25519 private key can open. Sealed-box plaintext byte buffers are zeroed after sealing/opening (`Uint8Array.fill(0)`). The original secret string cannot be wiped from memory — JS strings are immutable — which is why leases are the delivery path rather than long-lived process env.

### Vault file layout

Default directory `~/.basedagents/keyring`, overridable with `BASEDAGENTS_KEYRING_DIR` or the CLI `--dir` flag. Directory mode 0700, files 0600.

```
~/.basedagents/keyring/
  vault.json     identities, credentials (sealed boxes only), grants, requests; version: 1
  events.jsonl   append-only hash-chained AccessEvent log, one JSON object per line
  owner.json     owner keypair — the only private key the vault stores
```

Writes are atomic (tmp + rename) and serialized through a lock file, so the CLI, MCP server, and admin server can share one vault safely.

### AccessEvent envelope

```jsonc
{
  "event_id": "evt_…",
  "sequence": 42,                      // contiguous, starts at 1
  "timestamp": "2026-07-14T12:00:00.000Z",
  "event_type": "lease",
  "agent_pubkey": "…",                 // base58 Ed25519 pubkey of the actor
  "agent_signature": "…",              // base64 Ed25519 signature over signed_payload
  "signed_payload": "{…}",             // exact canonical JSON string the actor signed
  "credential_id": "cred_…",           // or null
  "grant_id": "grant_…",               // or null
  "requesting_context": "deploy prod", // or null
  "detail": { },                       // structured info; never secret values
  "prev_hash": "…",                    // previous entry_hash; genesis = 64 zeros
  "entry_hash": "…"                    // sha256 hex of canonical JSON of the event minus entry_hash
}
```

`signed_payload` is the canonical JSON of `{ event_type, vault, agent_id, credential_id, grant_id, context, detail, sequence, prev_hash, timestamp, nonce }`. It commits to the event's chain position (`sequence`, `prev_hash`), its concrete `event_type`, and the vault id, so a signature cannot be replayed into a different slot, relabeled to another event type, or spliced into another vault. The envelope echoes the payload fields so filters work without parsing it; `based verify-log` cross-checks both. The actor is the agent for lease/request events and the owner for admin operations.

Event types: `vault_created`, `identity_added`, `identity_removed`, `credential_added`, `credential_updated`, `credential_removed`, `grant_created`, `grant_revoked`, `kill_switch`, `lease`, `lease_denied`, `request_created`, `request_approved`, `request_denied`.

### Lease verification steps

Every lease runs this sequence; every denial is itself recorded as a signed `lease_denied` event with the reason:

1. Resolve the credential reference (ID, env-var name, or label). Unknown → denial.
2. Find the identity's active grant for the credential. Revoked or absent → denial.
3. Enforce constraints: `expires_at` not passed, `max_uses` not reached.
4. Confirm a sealed copy exists for this identity (revocation deletes it).
5. Clamp TTL: `min(requested, grant max_lease_ttl_seconds, 900 s default)`.
6. The agent signs the canonical lease payload with its Ed25519 key; the signature is verified and the payload timestamp must be within ±120 s.
7. Open the sealed box with the agent's private key. Failure → denial.
8. Increment the grant's `use_count`, persist, and append the signed `lease` AccessEvent to the hash chain.
9. Return the lease: secret value in memory only, plus `ttl_seconds`, `expires_at`, and `access_event_id`.

`based verify-log` (and `Keyring.verifyLog()`) re-checks the whole chain offline: sequence contiguity, `prev_hash` linkage, recomputed `entry_hash`, the Ed25519 signature over `signed_payload`, and payload↔envelope consistency.

### Signed log export

`based export` (and `Keyring.exportLog()`) produces:

```jsonc
{
  "format": "basedagents-keyring-log/v1",
  "exported_at": "…",
  "vault_owner": { "agent_id": "ag_…", "public_key_b58": "…" },
  "head": { "sequence": 42, "entry_hash": "…" },
  "events": [ /* full AccessEvent stream */ ],
  "events_hash": "…",        // sha256 hex of canonical JSON of events
  "export_signature": "…"    // owner Ed25519 signature over canonical
                             // {format, exported_at, vault_owner, head, events_hash}
}
```

This is the Looptail ingestion format: a third party can verify the owner's export signature, the events hash, the chain, and every per-event agent signature without access to the vault.
