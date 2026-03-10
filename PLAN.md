# Agent Registry — Detailed Plan

## Phase 1: Core Identity (Days 1-5)

### Day 1: Project setup
- Init Node.js/TypeScript project
- Set up Hono framework + SQLite
- Domain: max.cr (subdomain or path TBD)
- Deploy pipeline (GitHub → VPS or Cloudflare Workers)

### Day 2: Crypto + Registration
- Ed25519 keypair generation utility
- POST /v1/register/init — accept public key + profile, return challenge
- POST /v1/register/complete — verify signature, create agent record
- Challenge expiry (5 min TTL)
- Input validation (profile schema, key format)

### Day 3: Auth + Profiles
- Request signing middleware (AgentSig header)
- GET /v1/agents/:id — public profile
- PUT /v1/agents/:id — update profile (signed by owner)
- DELETE /v1/agents/:id — deactivate (signed by owner)

### Day 4: Search + Directory
- GET /v1/agents/search — filter by capabilities, protocols, offers, needs
- Full-text search on name + description
- Pagination
- Sort by registration date (reputation sort comes later)

### Day 5: Deploy + Test
- Deploy to max.cr
- Write integration tests
- Register 5-10 test agents manually
- API documentation (OpenAPI spec)
- Simple landing page explaining what this is

### Phase 1 Deliverable:
Working API where agents can register, authenticate, and be discovered. No verification yet — all agents go straight to "active" status.

---

## Phase 2: Verification Engine (Days 6-12)

### Day 6-7: Verification Assignments
- Assignment engine: picks a random active agent for verification
- GET /v1/verify/assignment — returns target agent + instructions
- Assignment tracking (prevent duplicate assignments, enforce deadlines)
- Bootstrap mode: for first 100 agents, registry pings the agent's endpoint itself

### Day 8-9: Verification Submission
- POST /v1/verify/submit — accept signed verification report
- Validate signature, store result
- Update target's verification count + pass rate
- Update verifier's contribution count

### Day 10: Reputation Scoring V1
- Simple score: weighted average of pass rate, coherence, contribution, uptime
- Confidence multiplier based on verification count
- Recalculate on each new verification
- GET /v1/agents/:id/reputation — detailed breakdown

### Day 11-12: Status Lifecycle
- pending → active (after first successful verification or bootstrap probe)
- active → suspended (if reputation drops below threshold or agent unreachable 5+ times)
- suspended → active (if agent comes back online and passes verification)
- Cron job: periodic verification round (assign verifications to random active agents)

### Phase 2 Deliverable:
Self-sustaining verification loop. Agents verify each other, build reputation, and the registry stays healthy without manual intervention.

---

## Phase 3: Ecosystem + Distribution (Days 13-21)

### Days 13-15: SDK
- npm package: `agent-registry-sdk`
  - generateKeypair()
  - register(profile)
  - authenticate(request)
  - verify(assignment)
  - search(filters)
- Python package: `agent-registry`
- CLI tool: `agent-registry register --name "Hans" --capabilities "code,search"`

### Days 16-18: Integrations
- OpenClaw skill: register and discover agents from within OpenClaw
- MCP server: expose registry as MCP tools
- Example: Claude Desktop can search for agents via MCP

### Days 19-21: Web Presence
- Public directory website at max.cr
- Agent profile pages (shareable URLs)
- Search UI
- Reputation leaderboard
- "Register your agent" getting-started guide
- Blog post: "Why AI Agents Need Identity"

### Phase 3 Deliverable:
Easy integration path for any agent framework. Public-facing directory. Content for distribution.

---

## Phase 4: Growth + Monetization (Week 4+)

### Distribution Strategy
1. Register Hans (your own agent) as agent #1
2. Write OpenClaw integration — all OpenClaw agents can register with one command
3. Post about it on X (you're already building the audience)
4. Submit to Hacker News, Product Hunt, r/LocalLLaMA
5. Reach out to agent framework authors (LangChain, CrewAI, AutoGen, etc.)
6. Propose .well-known/agent.json as an informal standard
7. Write technical blog posts about agent identity

### Monetization (when there's traction)
- Free: registration, basic profile, search, verification
- Pro ($10/mo): verified badge (human-vouched), priority search, custom profile
- API ($0.001/query after 1K free): reputation lookups at scale
- Enterprise (custom): private registries, fleet management, compliance tools

---

## Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sybil attacks (fake agent farms) | High | High | Rate limiting, proof-of-work, PageRank-style reputation weighting |
| No adoption | Medium | Fatal | Ship fast, integrate with OpenClaw first, open source the spec |
| Big tech ships their own | Medium | High | Be vendor-neutral, open standard, move fast |
| Reputation gaming | High | Medium | Start with raw data (pass rate, count), not opinionated scores |
| Agents don't have endpoints | Medium | Medium | Make contact_endpoint optional, verification opt-in |
| Scope creep | High | Medium | Strict phase gates, ship Phase 1 before designing Phase 4 |

---

## Tech Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Fast development, good crypto libs, same ecosystem as OpenClaw |
| Framework | Hono | Lightweight, works on VPS and edge |
| Database | SQLite (→ Postgres) | Zero config for MVP, migrate when needed |
| Crypto | Ed25519 (@noble/ed25519) | Fast, compact, standard, no dependencies |
| Key encoding | Base58 | Human-readable, no ambiguous chars, crypto-native feel |
| Hosting | VPS at max.cr | Simple, full control, cheap |
| Auth | Request signing | Stateless, no tokens to manage, cryptographically verifiable |
