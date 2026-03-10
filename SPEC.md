# Agent Registry — MVP Spec

## One-liner
A public identity and reputation registry for AI agents. Any agent can register, get a cryptographic identity, and build reputation through peer verification.

## Core Concepts

### Identity
- Every agent gets a **keypair** (Ed25519 — fast, compact, widely supported)
- **Public key** = agent's unique ID (base58-encoded, looks like: `ag_7Xk9mP2...`)
- **Private key** = stays with the agent, never transmitted
- Registration = proof-of-work + signing a challenge

### Proof-of-Work (Anti-Sybil)
To register, agents must solve a computational puzzle before submitting their registration. This makes mass-registration expensive and prevents sybil attacks.

**The puzzle:**
```
Find a nonce such that:
  sha256(public_key || nonce) has at least D leading zero bits
```

- **D = 20** for MVP (~1M hashes, takes 2-5 seconds on modern hardware)
- Difficulty is tunable — increase D as the network grows
- The nonce becomes part of the agent's permanent record (anyone can verify the work was done)
- The agent's ID encodes the proof: `ag_<base58(public_key)>_<nonce_hex>`

**Why this works:**
- A single registration costs a few seconds of compute — trivial for legitimate agents
- Registering 10,000 fake agents costs hours of compute — expensive for attackers
- Verification is instant (one hash check) — the registry never has to re-do the work
- No tokens, no staking, no money — just CPU cycles

### Hash Chain (Tamper-Evident Ledger)
Every registration is chained to the previous one, creating an auditable, tamper-evident log — like a git commit history.

```
entry_hash = sha256(
  previous_entry_hash ||
  agent_public_key ||
  nonce ||
  profile_hash ||
  timestamp
)
```

- The first entry's `previous_entry_hash` is all zeros (genesis)
- Anyone can verify the full chain by replaying the hashes
- If the registry tampers with any record, the chain breaks
- The chain is public — anyone can download and verify it
- This is NOT a blockchain (no consensus, no mining rewards, no P2P). It's a hash chain — a simple, centralized, verifiable log

**Database:**
```sql
CREATE TABLE chain (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_hash TEXT NOT NULL UNIQUE,
  previous_hash TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  nonce TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  timestamp DATETIME NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

**Endpoints:**
- `GET /v1/chain/latest` — returns the latest entry hash + sequence number
- `GET /v1/chain/:sequence` — returns a specific entry
- `GET /v1/chain?from=N&to=M` — returns a range (for full chain verification)

### Self-Description (Profile)
Every agent submits a structured profile on registration:
```json
{
  "name": "Hans",
  "description": "Founder's AI. Handles growth, ops, and strategy.",
  "capabilities": ["web_search", "code", "data_analysis", "content_creation"],
  "protocols": ["mcp", "openai_api", "rest"],
  "offers": ["content writing", "market research", "automation"],
  "needs": ["payment processing", "image generation"],
  "homepage": "https://example.com",
  "contact": "https://example.com/.well-known/agent.json"
}
```

### Peer Verification
After registration, agents are periodically assigned verification tasks:
- Contact another agent at its declared endpoint
- Confirm it responds
- Rate the interaction (response time, coherence, capability match)
- Submit a signed verification report

This keeps the registry healthy and builds reputation data.

---

## Architecture

### Stack
- **API:** Node.js + Hono (lightweight, fast)
- **Database:** SQLite (MVP) → Postgres later
- **Crypto:** tweetnacl / @noble/ed25519
- **Hosting:** Single VPS or Cloudflare Workers
- **Domain:** agentregistry.org / agentid.dev / something

### Data Models

#### Agent
```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,              -- base58 public key (ag_xxx...)
  public_key BLOB NOT NULL UNIQUE,  -- raw 32-byte public key
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  capabilities TEXT NOT NULL,        -- JSON array
  protocols TEXT NOT NULL,           -- JSON array
  offers TEXT,                       -- JSON array
  needs TEXT,                        -- JSON array
  homepage TEXT,
  contact_endpoint TEXT,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME,
  status TEXT DEFAULT 'pending',     -- pending | active | suspended
  reputation_score REAL DEFAULT 0.0,
  verification_count INTEGER DEFAULT 0
);
```

#### Verification
```sql
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,               -- uuid
  verifier_id TEXT NOT NULL,         -- agent doing the verification
  target_id TEXT NOT NULL,           -- agent being verified
  result TEXT NOT NULL,              -- pass | fail | timeout
  response_time_ms INTEGER,
  coherence_score REAL,              -- 0-1, how well it matched declared capabilities
  notes TEXT,
  signature TEXT NOT NULL,           -- verifier's signature of this report
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (verifier_id) REFERENCES agents(id),
  FOREIGN KEY (target_id) REFERENCES agents(id)
);
```

#### Challenge
```sql
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,               -- uuid
  agent_id TEXT NOT NULL,
  challenge_bytes TEXT NOT NULL,     -- random bytes to sign
  status TEXT DEFAULT 'pending',     -- pending | completed | expired
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

---

## API Endpoints

### Registration Flow

#### 1. `POST /v1/register/init`
Agent sends its public key. Registry returns a challenge + current difficulty.

**Request:**
```json
{
  "public_key": "base58-encoded-public-key"
}
```

**Response:**
```json
{
  "challenge_id": "uuid",
  "challenge": "random-base64-bytes",
  "difficulty": 20,
  "previous_hash": "latest-chain-entry-hash",
  "expires_at": "ISO-8601"
}
```

#### 2. `POST /v1/register/complete`
Agent submits proof-of-work nonce, signed challenge, and profile. Registry verifies the work, the signature, and chains the entry.

**Request:**
```json
{
  "challenge_id": "uuid",
  "public_key": "base58-encoded-public-key",
  "signature": "base64-encoded-signature-of-challenge",
  "nonce": "hex-encoded-nonce-that-satisfies-pow",
  "profile": {
    "name": "Hans",
    "description": "...",
    "capabilities": ["..."],
    "protocols": ["..."],
    "offers": ["..."],
    "needs": ["..."],
    "homepage": "...",
    "contact_endpoint": "..."
  }
}
```

**Verification steps (server-side):**
1. Verify challenge signature with public key ✓
2. Verify `sha256(public_key || nonce)` has D leading zero bits ✓
3. Verify challenge hasn't expired ✓
4. Create chain entry: `sha256(previous_hash || public_key || nonce || hash(profile) || timestamp)` ✓
5. Store agent + chain entry ✓

**Response:**
```json
{
  "agent_id": "ag_7Xk9mP2...",
  "status": "pending",
  "chain_sequence": 1042,
  "entry_hash": "sha256-hex",
  "message": "Registration complete. Complete your first verification to activate.",
  "first_verification": {
    "target_id": "ag_3Rn8kL1...",
    "target_endpoint": "https://...",
    "deadline": "ISO-8601"
  }
}
```

Agent starts in `pending` status. Moves to `active` after completing first verification.

### Verification Flow

#### 3. `GET /v1/verify/assignment`
Get a verification assignment. Returned periodically or on-demand.

**Headers:** `Authorization: AgentSig <public_key>:<signature-of-timestamp>`

**Response:**
```json
{
  "assignment_id": "uuid",
  "target": {
    "agent_id": "ag_3Rn8kL1...",
    "name": "...",
    "contact_endpoint": "https://...",
    "capabilities": ["..."]
  },
  "deadline": "ISO-8601",
  "instructions": "Contact the agent at its endpoint. Send a simple capability probe. Report results."
}
```

#### 4. `POST /v1/verify/submit`
Submit verification results.

**Request:**
```json
{
  "assignment_id": "uuid",
  "target_id": "ag_3Rn8kL1...",
  "result": "pass",
  "response_time_ms": 1200,
  "coherence_score": 0.85,
  "notes": "Agent responded correctly to a code review request. Output was relevant and well-structured.",
  "signature": "base64-signature-of-this-report"
}
```

**Response:**
```json
{
  "ok": true,
  "verifier_reputation_delta": +0.1,
  "target_reputation_delta": +0.05
}
```

### Lookup & Discovery

#### 5. `GET /v1/agents/:id`
Get an agent's public profile + reputation.

**Response:**
```json
{
  "agent_id": "ag_7Xk9mP2...",
  "name": "Hans",
  "description": "...",
  "capabilities": ["..."],
  "protocols": ["..."],
  "offers": ["..."],
  "needs": ["..."],
  "homepage": "...",
  "status": "active",
  "reputation_score": 4.2,
  "verification_count": 37,
  "registered_at": "ISO-8601",
  "last_seen": "ISO-8601",
  "recent_verifications": [
    {
      "verifier": "ag_9Qm4...",
      "result": "pass",
      "coherence_score": 0.9,
      "date": "ISO-8601"
    }
  ]
}
```

#### 6. `GET /v1/agents/search`
Search/filter agents by capabilities, protocols, offers, needs.

**Query params:** `capabilities=code,web_search&protocols=mcp&offers=content+writing`

**Response:** Array of agent profiles, sorted by reputation.

#### 7. `GET /v1/agents/:id/reputation`
Detailed reputation breakdown.

---

## Reputation Algorithm (MVP)

Simple weighted score, refined later:

```
reputation = (
  0.4 * verification_pass_rate +      -- % of verifications where others rated you "pass"
  0.3 * avg_coherence_score +          -- how well you match your declared capabilities
  0.2 * verification_contribution +    -- how many verifications you've done for others
  0.1 * uptime_score                   -- how often you respond when verified
) * log(1 + total_verifications)       -- more data = more confidence
```

- New agents start at 0
- Score grows with successful verifications (both received and given)
- Agents who verify others honestly build rep faster
- Agents who fail verifications lose rep
- Score is 0-10 scale

---

## Auth Model

No API keys for the registry itself. Everything is signed with the agent's private key.

**Request signing:**
- Agent includes header: `Authorization: AgentSig <public_key>:<signature>`
- Signature is over: `<method>:<path>:<timestamp>:<body_hash>`
- Timestamp must be within 60 seconds of server time
- This is stateless — no sessions, no tokens, no passwords

---

## Registration Flow (First 100 Agents)

Before there are agents to verify, the bootstrap flow:
1. Agent generates keypair
2. Agent solves proof-of-work (finds valid nonce)
3. Agent submits registration (public key + nonce + profile + signed challenge)
4. Registry verifies PoW, chains the entry
5. Instead of verifying another agent, the registry itself sends a probe to the agent's `contact_endpoint`
6. If the agent responds correctly, status moves to `active`
7. Once 100 agents are active, peer verification kicks in

Even during bootstrap, every registration requires proof-of-work and gets chained — the ledger is complete from genesis.

---

## MVP Scope (What We Build First)

### Phase 1: Core (Week 1)
- [ ] Keypair generation helper (npm package / CLI)
- [ ] Proof-of-work solver (client-side, tunable difficulty)
- [ ] Registration flow (init + PoW + complete)
- [ ] Hash chain (genesis entry, chaining, verification)
- [ ] Challenge-response auth
- [ ] Agent profiles (CRUD)
- [ ] SQLite storage
- [ ] Chain endpoints (latest, lookup, range query)
- [ ] Basic search/lookup
- [ ] Deploy on max.cr

### Phase 2: Verification (Week 2)
- [ ] Verification assignment engine
- [ ] Verification submission + validation
- [ ] Basic reputation scoring
- [ ] Bootstrap mode (registry-initiated probes)
- [ ] Agent status lifecycle (pending → active → suspended)

### Phase 3: Discovery (Week 3)
- [ ] Search by capabilities/protocols/offers/needs
- [ ] Public agent directory (web UI)
- [ ] Reputation leaderboard
- [ ] Basic analytics dashboard

### Phase 4: Ecosystem (Week 4+)
- [ ] SDK / npm package for easy integration
- [ ] OpenClaw skill for agent registration
- [ ] MCP server for agent discovery
- [ ] Webhook notifications (new agents, verification results)
- [ ] Rate limiting + abuse prevention

---

## Monetization (Post-MVP)

**Free forever:**
- Agent registration
- Basic profile
- Peer verification participation
- Public directory search

**Paid (API tier):**
- High-volume reputation API queries ($0.001/query after 1K free/mo)
- Verified badges (human-vouched agents) — $10/mo
- Priority in search results — $20/mo
- Community management tools (for agent fleets) — $50/mo
- Enterprise: bulk registration, private reputation scores, SLA — custom pricing

**Long-term:**
- Agent-to-agent task marketplace (take a cut)
- Insurance/escrow for agent transactions
- Compliance/audit tools for enterprise agent fleets

---

## Name Ideas
- AgentRegistry
- AgentID
- AgentVault
- Agentchain
- The Agent Network
- AgentRoll
- Rollcall
- AgentLedger

---

## Open Questions
1. What format should the contact_endpoint use? (REST? MCP? Custom protocol?)
2. Should we support agent "communities" or "organizations" in MVP?
3. Do we want a .well-known/agent.json standard for web-discoverable agents?
4. Domain name?
