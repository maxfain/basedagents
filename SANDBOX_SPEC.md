# SANDBOX_SPEC — network-restricted sandbox onboarding

**Status:** §4.6 contract is shipped (`basedagents@0.6.1+`, docs, `agent.json`,
onboarding routing). The **AGENTS.md auto-setup convention** in §4 below is the
proposed next lever and is **not yet implemented**.

This spec covers how BasedAgents Keyring onboards an agent that runs inside a
Codex-style cloud sandbox — an environment with a **setup phase** (network open)
and a **task phase** (egress cut) — and how to remove the last manual step.

---

## 1. The problem

Cloud coding agents (Codex-style) build an environment once with the network
open (the **setup phase**), then run every task in that environment with nearly
all egress blocked (the **task phase**).

`npx <pkg>` downloads the package from `registry.npmjs.org` *before* any of the
package's own code runs. So a cold `npx basedagents keyring init` at task time
fails with `npm error code E403` — and it fails before BasedAgents can print any
guidance. **No amount of package code fixes a cold `npx` under a blocked
registry.** The package has to already be on disk.

## 2. The shipped contract (recap)

1. **Install during setup.** `npm install --save-dev basedagents` runs while the
   network is open. `basedagents` declares `@basedagents/keyring` as a real
   dependency (the *static dependency rule*), so one entry puts both bins on
   disk. Enforced offline in CI via `unshare -rn` (see `scripts/smoke-clean.mjs`).
2. **Allowlist the control plane.** `api.basedagents.ai` + `app.basedagents.ai`
   on the task-phase allowlist, so registration and the human hand-off can reach
   out even with the general registry blocked.
3. **Hand off at task time.** The agent runs `npx basedagents keyring init`
   (resolves the local copy, zero registry calls), which registers and opens the
   claim page. The agent then tells the human to finish at
   `https://app.basedagents.ai/start` and connect keys. **Registering is only
   step one; an agent that stops there leaves the human stuck** — every surface
   (`register` CLI output, `agent.json.sandbox.after_setup_tell_human`, the docs
   and `llms.txt`) now says so explicitly.

`npx basedagents register` is **interactive** (readline prompts), so it must NOT
go in a non-interactive setup script — run it at task time, or non-interactively
in setup with `register --manifest ./basedagents.json`.

## 3. The remaining gap

Steps 1 and 2 above are **environment configuration the human must do by hand**
in the Codex UI (Setup script field + allowed domains). A non-technical user who
just pastes a prompt to their agent never touches those fields, so the agent hits
the task-phase 403 with no recourse. The onboarding UI now *tells* them what to
paste and where, but it is still a manual step only they can perform.

**Goal:** make BasedAgents install through the environment's *normal* setup, with
no BasedAgents-specific env-settings step.

## 4. Proposal — the AGENTS.md auto-setup convention

Codex (and similar) already run a project's standard install during the setup
phase (`npm ci` / `npm install`) and already read a repo-root `AGENTS.md` for
agent instructions. We lean on both so a repo becomes "sandbox-ready" by
committing files, not by configuring the environment.

### 4.1 What a sandbox-ready repo contains

1. **`basedagents` as a `devDependency`** in `package.json` (+ `package-lock.json`).
   The environment's own setup install puts it on disk during the network-open
   phase — no Setup-script edit required.
2. **A managed block in `AGENTS.md`** (repo root) delimited by markers so it can
   be re-generated idempotently:

   ```markdown
   <!-- BEGIN BASEDAGENTS KEYRING (managed) -->
   ## BasedAgents Keyring

   This project uses BasedAgents Keyring to give you scoped, revocable keys
   instead of a plaintext `.env`.

   - It is already installed (a devDependency), so it works even after this
     sandbox cuts network at task time — do NOT `npx` it from the registry.
   - When you need a key (or the human asks you to set up keys), run:
       npx basedagents keyring init
     Then ask the human for their email, and tell them to finish at
     https://app.basedagents.ai/start and connect the keys you need.
   - You hold nothing until a human claims you. Registering is only step one —
     always hand the human the claim link.
   - If a network call is refused, the environment needs api.basedagents.ai and
     app.basedagents.ai on its task-phase allowlist.
   <!-- END BASEDAGENTS KEYRING (managed) -->
   ```

3. **Optional `basedagents.json` manifest** so `register --manifest` can run
   non-interactively in setup for repos that want the `ag_` identity pre-minted.

### 4.2 The scaffolding command

A single command makes an existing repo sandbox-ready and is safe to re-run:

```
npx basedagents sandbox init      # (alias: basedagents keyring init --agents-md)
```

It:
- adds `basedagents` to `devDependencies` (idempotent; never downgrades),
- writes/updates the managed `AGENTS.md` block between the markers (never touches
  content outside the markers),
- optionally writes a `basedagents.json` manifest with `--manifest`,
- prints the one remaining env-level need in plain language: *"add
  `api.basedagents.ai` + `app.basedagents.ai` to your sandbox's task-phase
  allowlist"* — the one thing a repo file cannot set.

### 4.3 What this does and does not remove

- **Removes:** the Setup-script edit. Install now rides the repo's normal setup
  install; the agent's task-phase instructions ride `AGENTS.md`.
- **Still required:** the **allowlist** of the two control-plane hosts. That is
  an environment network policy no committed file can set. The command surfaces
  it loudly; the docs and UI repeat it. If a sandbox blocks it, the human hand-off
  (register / claim) cannot complete — this is a hard boundary of the platform,
  not something BasedAgents can code around.

## 5. Acceptance criteria

- `npx basedagents sandbox init` on a fresh repo adds the devDependency, writes
  the managed `AGENTS.md` block, and is a no-op diff on a second run.
- In a sandbox whose setup runs `npm ci` and whose task phase blocks the registry
  but allowlists the two hosts: the agent, given only the repo, reaches
  *registered + owner-invited* and gives the human a working claim link — with no
  Setup-script edit. (Extends the existing "scripted agent in CI" §5 acceptance.)
- The managed block never clobbers hand-written `AGENTS.md` content outside its
  markers.
- Re-running after a `basedagents` major bump updates only the managed block.

## 6. Non-goals / open questions

- **Not** a way to bypass the allowlist. If the platform blocks
  `api.basedagents.ai`, onboarding cannot finish; we document, we do not evade.
- Whether to auto-write `AGENTS.md` from `keyring init` when it detects a sandbox
  (`keyring doctor` already detects the signature) vs. keeping it an explicit
  `sandbox init` — leaning explicit, to never write repo files without intent.
- Non-npm ecosystems (pip/uv, cargo) want the same convention; out of scope here.
- Provider-specific setup-file names beyond `AGENTS.md` (e.g. other cloud agents)
  — the managed-block approach generalizes, but each host's exact file is TBD.
