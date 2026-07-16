# @basedagents/console

The owner console for the BasedAgents Keyring control plane — the web app at
`app.basedagents.ai` where an owner signs in with a passkey and approves the
credential grants their agents request.

> **Proprietary.** This package is closed source (see `LICENSE` and the
> repository‑root `LICENSING.md`). Everything that touches secret material is
> open source and lives elsewhere; this app never sees a secret.

## What it does

- **Passkey sign‑up / sign‑in** — "sessions to look" (CONTROL_PLANE.md §3): a
  passkey login mints an httpOnly, `SameSite=Strict`, read‑only session cookie.
- **Approvals inbox** — the owner reviews each pending `keyring_request` and
  approves it with a **fresh WebAuthn assertion bound to the exact action**
  ("signatures to act"). The server arms the challenge from the request's own
  stored data (`POST /requests/:id/approve/begin`); the console re‑hashes the
  returned canonical and **refuses to sign unless it matches** the challenge
  (client‑side WYSIWYS), so the human signs exactly what is displayed.
- **Agents** — create and revoke owner→agent delegations (an agent can only
  request credentials once delegated). Every mutation runs the shared ceremony
  (`lib/ceremony.ts`): `/action/begin` → client‑side WYSIWYS → passkey
  assertion. The WYSIWYS step parses the server's canonical and requires it to
  say *exactly* what the console asked for (action type, signed‑in owner,
  ceremony nonce, byte‑identical params) — for actions with no daemon
  re‑verification, this check is what stands between a compromised control
  plane and the owner's passkey signing a swapped action.
- **Vault** — bind the vault key (derived from the signed‑in owner id itself,
  nothing to mistype), which is what lets the local daemon authenticate to pull
  approvals (`based sync`); list passkeys; generate the one‑time **recovery
  code** (shown once, stored hashed).
- **Recovery** (`/recover`, public) — email magic link **plus** the recovery
  code (both required, neither sufficient alone) authenticate enrolling a new
  passkey; every other passkey and session is revoked. Authority rotates;
  the vault key and ciphertext are never touched (CONTROL_PLANE.md §6).

A grant only shows as **active after the local vault daemon confirms it** — the
console can queue an approval but never seal a secret. A compromised console can
delay or drop a grant; it cannot forge one, redirect its seal target, or read a
secret (CONTROL_PLANE.md §2).

## Architecture boundary

```
 browser (this app)            control plane (packages/api/src/control)         local vault daemon (packages/keyring)
 ─────────────────             ────────────────────────────────────────         ────────────────────────────────────
 passkey ceremonies    ──►     verifies WebAuthn, queues grant_approvals   ◄──   `based sync` pulls, RE-verifies the
 (no secret material)          (never sees a secret)                              assertion vs a locally-anchored
                                                                                  passkey, then seals the secret
```

## Develop

```bash
npm run dev --workspace=packages/console     # http://localhost:5174, proxies /v1 → :3000
npm run build --workspace=packages/console   # tsc + vite build
npm run test  --workspace=packages/console   # vitest (pure encoding/WYSIWYS helpers)
```

Set `VITE_API_URL` to point at a non‑default control plane (defaults to
`https://api.basedagents.ai`).
