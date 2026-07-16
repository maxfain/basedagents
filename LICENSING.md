# Licensing

BasedAgents follows an **open-core** model — the same split Tailscale uses.

**Everything that touches secrets or runs on a user's machine is open source
(Apache-2.0).** The hosted control plane — the console, owner accounts, and
billing — is proprietary. There is a trust argument for opening the code that
holds and moves your credentials; there is no trust argument for opening the
web app that runs our servers.

## Open source — Apache-2.0

These components are, and will remain, Apache-2.0. They are the code you run
locally, the code that handles secret material, and the community surface.

| Component | Package | What it is |
|---|---|---|
| Crypto core | `packages/keyring` | Sealed-box encryption, signing, the tamper-evident access log |
| Vault daemon & CLI | `packages/keyring` (`based`) | Local encrypted vault, grants, leases, `based run` env injection |
| Keyring MCP server | `packages/keyring` (`basedagents-keyring-mcp`) | `keyring_list` / `keyring_lease` / `keyring_request` |
| Registry MCP server | `packages/mcp` | Agent search / profile / reputation over MCP |
| TypeScript SDK | `packages/sdk` | Client for the registry + identity/signing helpers |
| Python SDK | `packages/python` | Python client (MIT) |
| GitHub Action | `packages/github-action` | Auto-registration in CI |
| **Recipe library** | `packages/recipes` | Community-contributed Provisioner recipes (see below) |

All open packages are Apache-2.0 except the Python SDK, which is MIT — both are
permissive open-source licenses.

The **recipe library is non-negotiably open.** Coverage of the long tail of
providers is the Provisioner's moat, and that coverage only compounds if the
community can read, audit, sign, and contribute recipes freely. Recipes are
signed and domain-sandboxed (a recipe may navigate only its declared domains
and may only *write* captured values into the vault — never read existing
ones), so "open" here also means "auditable," which is the point.

Each open package carries its own `LICENSE` (Apache-2.0) so it stays open when
vendored or published independently.

## Proprietary — all rights reserved

The **hosted control plane** is closed source:

- The owner console (`app.basedagents.ai`) — accounts, the fleet/agent/credential
  screens, approvals, timeline UI.
- Owner authentication, account management, and recovery.
- Billing and any hosted-only orchestration.

These are being built per `KEYRING_SPEC.md` v0.2 (§5). The control-plane code
lives in two proprietary places:

- **`packages/console/`** — the owner console web app (`app.basedagents.ai`):
  passkey sign-in, the approvals inbox, and (later) delegations, recovery, and
  billing screens. A standalone package so the closed console is cleanly
  separated from the open, Apache-2.0 public site (`packages/web`). Carries its
  own proprietary `LICENSE` (`packages/console/LICENSE`). All rights reserved.
- **`packages/api/src/control/`** — the control-plane API: owner accounts,
  WebAuthn/passkey authority, sessions, delegations, and approvals. A
  proprietary subtree inside the otherwise-open `packages/api`. Carries its own
  proprietary `LICENSE` (`packages/api/src/control/LICENSE`). All rights reserved.
- The control-plane D1 migrations it depends on (`packages/api/migrations/0023_owner_accounts.sql`
  onward) are covered by the same proprietary terms — they live in the shared
  registry database only because the owner→agent delegation edge references the
  open `agents` table.

`packages/api` is therefore **mixed-license**: the registry API (agents,
reputation, tasks, chain, scan) is Apache-2.0; the `src/control/` subtree and its
migrations are proprietary. Everything outside `src/control/` stays open. See
`CONTROL_PLANE.md` for the architecture.

This was authorized after confirming the contributor-consent check below: the
control-plane code is newly written and the surrounding `api` code it extends was
authored solely by the project's own identities.

**The control plane can never read a secret.** The open/closed split is a
licensing boundary, not a trust boundary: secret ciphertext and leases live in
the local vault daemon (open source, above); the control plane stores only
metadata and grant records. See `KEYRING_SPEC.md` §5.2 (hosted control plane,
local data plane).

> Scope of the api relicensing: only `packages/api/src/control/` and the
> control-plane migrations (`0023_owner_accounts.sql` onward) are proprietary.
> The rest of `packages/api` and all of `packages/web` remain Apache-2.0. The
> owner console is its own proprietary package (`packages/console`), kept
> separate from the public directory/registry UI in `packages/web` so the open
> site stays entirely open — no relicensing of any existing open code.

## Contributors & consent

Relicensing already-merged code from Apache-2.0 to proprietary requires the
consent of anyone whose contributions are affected. As of this writing:

- **Outside contributions to source code: none.** The only third-party merge is
  a documentation change (an MCP badge in `README.md`). No external contributor
  has touched code that is a candidate for the proprietary license.
- The bulk of the codebase was authored by the project's own identities
  (the project's build agent and Claude), whose output is owned by the project.

Before any Apache-2.0 code is moved to the proprietary license, re-run the
check and confirm no affected file carries an outside contribution:

```
git log --all --format='%an <%ae>' | sort | uniq -c        # who has committed
git log --all --author='<email>' --name-only --format=''    # what they touched
```

**Future contributions.** By opening a pull request against an open-source
package, contributors agree their contribution is provided under that package's
Apache-2.0 license. Contributions to the proprietary control plane are not
accepted from outside the project.

## Questions

Open a discussion or email the address in the root `README.md`.
