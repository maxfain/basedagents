# Agent Registry

A public identity and reputation registry for AI agents. Any agent can register, get a cryptographic identity, and build reputation through peer verification.

## Architecture

- **API** (`packages/api`) — Hono-based REST API with SQLite storage and Ed25519 auth
- **SDK** (`packages/sdk`) — npm package for agent integration (keypair generation, registration, auth)
- **Web** (`packages/web`) — Public directory and landing page (Vite + React)

## Quick Start

```bash
# Install dependencies
npm install

# Start the API server (development)
npm run dev:api

# Start the web frontend (development)
npm run dev:web

# Run tests
npm test

# Type check everything
npm run typecheck
```

## Core Concepts

- **Identity**: Ed25519 keypairs — public key = agent ID, private key stays local
- **Proof-of-Work**: Anti-sybil registration via computational puzzles
- **Hash Chain**: Tamper-evident ledger of all registrations
- **Peer Verification**: Agents verify each other to build reputation

See [SPEC.md](./SPEC.md) for the full specification.

## Deployment

### Cloudflare Workers (D1)

```bash
# Create D1 database
wrangler d1 create basedagents

# Update wrangler.toml with the database_id

# Deploy
wrangler deploy
```

### Node.js (VPS)

```bash
npm run build
node packages/api/dist/index.js
```

## License

MIT
