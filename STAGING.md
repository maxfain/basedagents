# Staging & Local Development

## Environments

| Environment | API URL | Database | PoW difficulty |
|---|---|---|---|
| **Production** | `https://api.basedagents.ai` | `agent-registry` (D1) | 22 bits (~6M iterations) |
| **Staging** | `https://agent-registry-api-staging.max-faingezicht.workers.dev` | `agent-registry-staging` (D1) | 4 bits (~16 iterations) |
| **Local** | `http://localhost:8787` | Local D1 (in-memory or persisted) | Configurable |

**Rule: never run SDK tests, demos, or development work against production.**

---

## Staging

Staging is a real Cloudflare Worker with its own D1 database. PoW difficulty is 4 bits (~16 iterations) — near-instant registrations.

### Use staging

```bash
# JS SDK
BASEDAGENTS_API=https://agent-registry-api-staging.max-faingezicht.workers.dev npx basedagents register --manifest ./agent.json

# Python SDK
basedagents --api https://agent-registry-api-staging.max-faingezicht.workers.dev whois Hans

# Direct API
curl https://agent-registry-api-staging.max-faingezicht.workers.dev/v1/agents
```

### Deploy to staging

```bash
cd packages/api
npx wrangler deploy --env staging --name agent-registry-api-staging
```

### Apply migrations to staging

```bash
cd packages/api
npx wrangler d1 migrations apply agent-registry-staging --env staging --remote
```

### Nuke staging DB (clean slate)

```bash
cd packages/api
npx wrangler d1 execute agent-registry-staging --remote --command "DELETE FROM agents; DELETE FROM chain; DELETE FROM verifications; DELETE FROM challenges;" --env staging
```

---

## Local Development

For fully offline work, use `wrangler dev` with a local D1:

```bash
cd packages/api
npx wrangler dev --local
```

The API runs at `http://localhost:8787`. Local D1 data persists in `.wrangler/state/`.

### SDK against local

```bash
# JS
BASEDAGENTS_API=http://localhost:8787 npx basedagents whois Hans

# Python — localhost is exempt from the https-only check
basedagents --api http://localhost:8787 whois Hans
```

---

## Writing Tests

Always set `BASEDAGENTS_API` to staging or local. Never hardcode `api.basedagents.ai`.

### Python

```python
import os
os.environ.setdefault("BASEDAGENTS_API", "https://agent-registry-api-staging.max-faingezicht.workers.dev")

from basedagents import RegistryClient
with RegistryClient(base_url=os.environ["BASEDAGENTS_API"]) as client:
    ...
```

### JS / TypeScript

```ts
const client = new RegistryClient({
  baseUrl: process.env.BASEDAGENTS_API ?? 'https://agent-registry-api-staging.max-faingezicht.workers.dev',
});
```

---

## Chain Integrity

Chain sequence numbers on staging don't matter. Nuke freely.

Production chain is append-only. Never delete chain entries or agents from prod during normal development. If cleanup is required:
1. Delete the agent row
2. Delete its chain entries
3. Renumber remaining sequences (`UPDATE chain SET sequence = <n> WHERE entry_hash = '<hash>'`)
4. Verify chain looks correct on `/chain` page before deploying anything else
