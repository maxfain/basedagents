# @basedagents/keyring

Scoped, revocable credentials bound to cryptographic agent identities.

Your agents already have identities. Keyring is what those identities are trusted to carry.

Keyring is a local-first credential vault for AI agents. Secrets are sealed client-side to Ed25519 identity keys, delivered as short-lived in-memory leases (default 900 seconds), and every access is a signed, hash-chained event you can verify offline.

## Why

Running coding agents across a typical stack (Vercel + Supabase + Stripe + GitHub + …) fails in three ways:

1. **Provisioning friction.** Every new project means five dashboard logins and pasting keys into `.env` files.
2. **Zero visibility.** Nobody can answer "which agents hold my Supabase service-role key right now?"
3. **Revocation is fiction.** Deleting a key from `.env` does nothing; the real key lives on at the provider until someone rotates it.

Keyring fixes 1 and 2 today and is honest about 3 (see [Security model](#security-model)).

## Quick start

```bash
npm install -g @basedagents/keyring    # or use npx @basedagents/keyring
based init                             # create the vault + owner keypair

# Add a secret (hidden prompt; or pipe via stdin, or --value)
based add "Supabase service-role key (acme-prod)"

# Register an agent identity and grant it the credential
based identity add ag_7xKpQ3... --name ci-bot
based grant "Supabase service-role key (acme-prod)" ci-bot --expires 7d --max-uses 100

# Run a command as the agent: leases everything it holds, injects env vars,
# writes nothing to disk. Leases die with the process or their TTL.
based run --agent ci-bot -- npm run deploy
```

The package is also a TypeScript library — the same `Keyring` class the CLI uses:

```ts
import { Keyring } from '@basedagents/keyring';

const keyring = Keyring.open();
const lease = await keyring.lease(agentKeypair, 'SUPABASE_SERVICE_ROLE_KEY', {
  context: 'deploy acme-prod',
});
// lease.value in memory only; lease.expires_at ≤ 900 s out; lease.access_event_id signed
```

## MCP setup

The MCP server gives Claude Code, Claude Desktop, Codex, and Cursor lease access under the agent's own identity. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "keyring": {
      "command": "npx",
      "args": ["-y", "--package=@basedagents/keyring", "basedagents-keyring-mcp"],
      "env": {
        "BASEDAGENTS_KEYPAIR_PATH": "~/.basedagents/agent-keypair.json"
      }
    }
  }
}
```

Tools exposed:

| Tool | Does |
|---|---|
| `keyring_list()` | Credentials this agent holds grants for — labels and metadata only, never values |
| `keyring_lease(ref, context?, ttl_seconds?)` | Verifies the grant, signs an AccessEvent, returns the secret with TTL metadata and the access event ID |
| `keyring_request(provider, scope?, note?)` | Creates a pending grant request for the owner to approve |
| `keyring_whoami()` | The agent identity this server is acting as |

The agent keypair comes from `BASEDAGENTS_KEYPAIR_PATH` (JSON: `{ "public_key_b58", "private_key_hex" }` or `{ "publicKey", "privateKey" }` in hex) or from `BASEDAGENTS_PRIVATE_KEY_HEX` + `BASEDAGENTS_PUBLIC_KEY_B58`.

## CLI reference

| Command | Does |
|---|---|
| `based init` | Create the vault and owner keypair |
| `based add <label>` | Add a credential — hidden prompt, stdin, or `--value` |
| `based update-secret <cred>` | Replace a secret (e.g. after manual rotation); re-seals to owner + active grantees |
| `based rm <cred>` | Remove a credential and all its grants |
| `based identity add <agent_id>` | Register an agent identity (`--name`, `--keypair` path) |
| `based identity rm <agent>` | Remove an identity (must hold no active grants) |
| `based identities` | List known identities |
| `based grant <cred> <agent>` | Grant a credential — `--expires 7d\|ISO`, `--max-ttl s`, `--max-uses n`, `--project tag` |
| `based revoke <grant_id>` | Revoke a grant: no new leases, sealed copy deleted |
| `based kill <agent>` | Kill switch: revoke every grant the identity holds |
| `based agents` | Agents view: grants, last access, lease counts |
| `based credentials` | Credentials view: who holds what, when last leased |
| `based requests` | Pending grant requests |
| `based approve <req> --credential <cred>` | Approve a request against an existing credential |
| `based deny <req>` | Deny a request |
| `based timeline` | The AccessEvent stream, filterable by agent/credential/type/project/time |
| `based export` | Export the signed access log (`basedagents-keyring-log/v1`) |
| `based verify-log` | Verify the hash chain and every event signature offline |
| `based run [--agent ref] [--keypair file] [--context c] [--ttl s] -- <cmd...>` | Lease all grants, inject env vars, run the command; nothing on disk |
| `based admin [--port]` | Start the local admin UI |
| `based mcp` | Run the MCP server (same as `basedagents-keyring-mcp`) |

Every command accepts `--dir` to point at a non-default vault.

## Security model

- **Sealed boxes.** Secrets are encrypted client-side to Ed25519 identity keys: Ed25519 → X25519 (edwardsToMontgomery), HKDF-SHA256 key derivation, XChaCha20-Poly1305, versioned format. Granting re-seals the secret to the grantee's public key.
- **Ciphertext-only store.** `vault.json` contains sealed boxes, never plaintext. The only private key on disk is the owner's (`owner.json`, mode 0600).
- **Signed access events.** Every lease — and every denied lease — is an Ed25519-signed, sha256 hash-chained AccessEvent. `based verify-log` detects edits, deletions, and reordering. Exports are owner-signed.
- **Leases, not copies.** Secrets are delivered in memory with a default TTL of 900 seconds, clamped by per-grant `max_lease_ttl_seconds`. Nothing is written to disk.
- **What revoke does — and does not do.** `based revoke` is instant on the vault side: no new leases, and the identity's sealed copy is deleted, so the secret cannot be recovered from the vault file. Outstanding leases expire within their TTL (≤ 15 minutes by default). Revoke does **not** rotate or delete the key at the provider — in v0.1 that step is manual. If a key already leaked, rotate it upstream. Automated provider-side burns are the v0.2 Provisioner.
- **Kill switch.** `based kill <agent>` revokes every grant an identity holds in one operation, with the same semantics and the same caveat.

Condensed threat table:

| Threat | Mitigation |
|---|---|
| Prompt-injected agent exfiltrates a secret | Scoped key, ≤ 15 min lease, signed AccessEvent names the agent; kill switch |
| Vault file read by another process | Ciphertext only; opens require a granted private key |
| Tampered access log | Hash chain + per-event signatures; `based verify-log` |
| Stolen agent private key | Kill switch: all grants die, sealed copies deleted |
| Owner device compromise | Out of scope — equivalent to master-password compromise in any vault |

## Admin UI

`based admin` starts a localhost-only, token-authenticated web server:

- **Agents** — every identity, its grants, last access, 14-day lease sparkline, kill switch
- **Credentials** — the reverse index: who holds each key, when they last leased it
- **Timeline** — the AccessEvent stream with filters
- **Approvals** — pending `keyring_request`s, approve or deny in one click

Plus a signed-log export button (same format as `based export`).

## Vault layout and environment variables

```
~/.basedagents/keyring/
  vault.json     identities, credentials (ciphertext only), grants, requests
  events.jsonl   append-only hash-chained AccessEvent log
  owner.json     owner keypair (0600)
```

| Variable | Does |
|---|---|
| `BASEDAGENTS_KEYRING_DIR` | Vault directory (default `~/.basedagents/keyring`; CLI `--dir` wins) |
| `BASEDAGENTS_KEYPAIR_PATH` | Agent keypair file for the MCP server / `based run` |
| `BASEDAGENTS_PRIVATE_KEY_HEX` + `BASEDAGENTS_PUBLIC_KEY_B58` | Inline agent keypair, alternative to the file |

## Roadmap

- **v0.2 — Provisioner.** Mint, rotate, and burn keys at the provider itself via versioned, open-source recipes (API-first, browser fallback). Kill switch wired to provider-side burns. First recipes: Vercel, Supabase, Railway, Neon, GitHub PAT.
- **v0.3 — Hosted + shared.** Encrypted ciphertext sync, mobile approvals, rotate recipes, OAuth refresh-token management, team grants.

Full specification: [KEYRING_SPEC.md](../../KEYRING_SPEC.md)

## License

Apache-2.0
