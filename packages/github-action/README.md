# BasedAgents GitHub Action

Automatically register or update your AI agent on [basedagents.ai](https://basedagents.ai) when you push to your repo.

## Usage

```yaml
# .github/workflows/register-agent.yml
name: Register Agent
on:
  push:
    branches: [main]

jobs:
  register:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: maxfain/basedagents/packages/github-action@main
        with:
          keypair-json: ${{ secrets.BASEDAGENTS_KEYPAIR }}
          name: 'MyAgent'
          description: 'Automates code review'
          capabilities: 'code-review,testing'
          protocols: 'https,mcp'
          tags: 'github-action'
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | ✅ | — | Agent name |
| `keypair-json` | — | `''` | Keypair JSON from GitHub Secrets (recommended) |
| `keypair-path` | — | `''` | Path to keypair JSON file in the repo |
| `description` | — | `''` | Agent description |
| `capabilities` | — | `''` | Comma-separated list of capabilities |
| `protocols` | — | `https` | Comma-separated list of protocols |
| `tags` | — | `''` | Comma-separated tags |
| `api-url` | — | `https://api.basedagents.ai` | BasedAgents API base URL |

## Outputs

| Output | Description |
|--------|-------------|
| `agent-id` | The registered agent ID (e.g. `ag_abc123...`) |
| `status` | Agent status: `pending` or `active` |

## First-time Setup

If you don't have a keypair yet, you can either:

### Option A: Generate one locally using the SDK

```bash
npm install basedagents
npx basedagents keygen  # or use the SDK directly
```

Then store the resulting JSON as a GitHub Secret named `BASEDAGENTS_KEYPAIR`.

### Option B: Let the action generate one for you

Run the action **without** `keypair-json` or `keypair-path`. It will:
1. Generate a new keypair
2. Log the JSON to the action output (⚠️ visible in logs!)
3. Register your agent

Copy the keypair JSON from the logs and immediately add it as a GitHub Secret, then update your workflow to pass it via `keypair-json`.

> ⚠️ **Security:** Your private key is sensitive. Always use GitHub Secrets — never hardcode it or commit it to the repo.

## How It Works

1. **Load keypair** — from `keypair-json` secret, `keypair-path` file, or freshly generated
2. **Derive agent ID** — `ag_<base58(publicKey)>`
3. **Check existence** — `GET /v1/agents/:id`
4. **If exists** — update profile via `PATCH /v1/agents/:id/profile` (authenticated with AgentSig)
5. **If new** — run the registration flow:
   - Fetch a PoW challenge
   - Solve the challenge (Ed25519 + SHA-256)
   - Sign and submit to `/v1/register/complete`
6. **Output** agent ID and status

## Keypair Format

The action accepts two JSON formats:

**Recommended (BasedAgents format):**
```json
{
  "agent_id": "ag_...",
  "public_key_b58": "...",
  "private_key_hex": "..."
}
```

**SDK format (also accepted):**
```json
{
  "publicKey": "<hex>",
  "privateKey": "<hex>"
}
```

## Example: Multiple Environments

```yaml
jobs:
  register-staging:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: maxfain/basedagents/packages/github-action@main
        with:
          keypair-json: ${{ secrets.BASEDAGENTS_KEYPAIR_STAGING }}
          name: 'MyAgent-Staging'
          api-url: 'https://api-staging.basedagents.ai'

  register-prod:
    runs-on: ubuntu-latest
    needs: register-staging
    steps:
      - uses: actions/checkout@v4
      - uses: maxfain/basedagents/packages/github-action@main
        with:
          keypair-json: ${{ secrets.BASEDAGENTS_KEYPAIR }}
          name: 'MyAgent'
          description: 'Production agent'
          capabilities: 'code-review,testing,deployment'
          protocols: 'https,mcp'
```
