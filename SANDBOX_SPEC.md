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

## 2b. The cold-window reality: the prompt is the only channel

Field-tested finding (2026-07): **most people start in a fresh Codex window and
paste the setup prompt into a task** — no Setup script configured, no allowlist,
no devDependency. At that moment the agent has:

- no registry (`npx` → E403 before any of our code runs),
- no way to fetch our docs or `agent.json` (those hosts are blocked too),
- no package on disk (so no CLI, no `doctor`),
- and no safe repo edit: adding `basedagents` to `package.json` without
  regenerating `package-lock.json` breaks the next setup's `npm ci`, and the
  lock cannot be regenerated offline.

The **only** inbound channel that reaches the agent in that state is the prompt
the human pasted — but the agent has an outbound channel (its reply), and the
**human's browser is unrestricted**. So the prompt does not need to carry the
recovery *payload*; it needs to carry a **pointer** the agent relays verbatim.

The canonical fallback clause (human-facing paste blocks — homepage hero +
closing, console `AgentSetupPrompt` — must stay marketing-short):

> Sandbox blocking npm? Don't work around it — tell me (keep the URL exact):
> the one-time fix is at basedagents.ai/codex, then I start a new task.

Design rules, field-tested (in both directions):
- **URL-exact relay, own words.** An unquoted "tell me to fix it" invites
  paraphrase that drops the URL — so the clause pins the URL and the new-task
  step ("keep the URL exact"). But scripting the agent's EXACT reply
  (`tell me: "…"`) reads as output-steering to a security-conscious agent and
  got the entire setup refused in the field. Pin the content, not the wording.
- **There are two walls, not one.** Field-hit both: (a) npm blocked at task
  time (E403 before any of our code runs) and (b) npm ALLOWED but
  api.basedagents.ai not in the environment's allowed domains — `init` then
  creates the vault + agent locally and fails only at the link step. `init`
  must stay resumable (re-run reuses vault + agent) and must print the /codex
  pointer itself in that state, flavored for the allowed-domains step — the
  agent should not have to improvise the relay.
- **Never end a task without the next step.** Field-hit: an install-only task
  ("npm install --save-dev basedagents") completed correctly and silently — the
  human saw "done" with nothing to do next. Installing is step zero; every
  surface that suggests the install command must pair it with its successor
  (start a new task, paste the setup prompt), and agent-facing docs must tell
  agents to END install replies with that next step (agent.json
  `after_install_tell_human`).
- **Survive the skeptical agent.** The setup prompt is indistinguishable from a
  supply-chain phish unless it gives the agent something to verify: provenance
  links (npm package name, GitHub repo, docs URL — exact, so a bad search
  doesn't "prove" we don't exist), the EXPECTED behavior of `init`, and a
  tripwire aligned WITH agent safety ("it never asks for a password or an
  existing key — stop and tell me if anything differs"). "Follow its
  instructions" is banned copy: it asks the agent to obey unknown program
  output, which cautious agents rightly refuse. `/.well-known/agent.json`
  carries a `provenance` block for agents that go and check.
- **"Start a new task" must survive the relay.** Fixing the environment does not
  revive the current dead task; without this step the human retries in place and
  loops on the 403.
- **`/codex` is a permanent URL** (static leaf page, human-facing, self-canonical,
  `/sandbox` aliases to it). Pageviews fire the `codex_recovery_view` funnel
  event — a live count of cold-sandbox failures in the wild.
- **The retry prompt must DIVERGE (field-tested 2026-07).** The first `/codex`
  iteration's step-3 paste prompt was byte-identical to the original pointer
  prompt, on the theory that a botched environment fix would "self-heal" by
  relaying back to `/codex`. Field screenshots falsified that: a user followed
  the page, the fix didn't take (classic miss: the Setup-script line pasted
  into the *chat* instead of the environment settings — the agent then
  obligingly ran `npm install` under a dead network), and the retry produced
  the identical 403 → the identical "open basedagents.ai/codex" relay → a loop
  with zero new signal. The step-3 prompt now has the agent check
  `node_modules/.bin/basedagents` BEFORE touching npm and, on a miss, relay a
  *different* message that names what didn't take ("the install didn't run
  during setup — step 1 goes in the environment settings…"); an allowlist miss
  gets its own relay line. Rule: every recovery prompt must produce a distinct
  next message on failure — never the message that led to it.
- **The setup log is the ground truth.** Codex prints an "Environment setup"
  log per task; its auto setup runs `npm install --no-save --no-package-lock`
  against the repo's `package.json`. "No installations were performed" ⇒
  neither the Setup script nor a committed devDependency was in effect for the
  environment that task used. Corollary: because auto setup installs
  `package.json` dependencies with the network open, a devDependency committed
  from the human's own machine (lockfile regenerated properly) rides the
  *automatic* install with no Setup-script edit at all — `/codex` now offers
  that as an equal path (§4's convention, minus the AGENTS.md block).
- **Machine surfaces keep the full payload.** `agent.json`
  (`on_403_relay_to_human`, `human_recovery_page`) and the `llms.txt` mirrors
  carry the pointer *and* the underlying steps — they are read by agents that
  can fetch (and seed training data), and are not length-constrained.

Any onboarding surface that hands a human a prompt to paste MUST include the
pointer clause — a prompt without it strands the default cold-start user.

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
