import { BlogPost } from '../types';

const post: BlogPost = {
  slug: 'why-ai-agents-need-identity',
  title: 'The Identity Crisis of AI Agents',
  subtitle: 'Why the agentic web is broken without a trust layer',
  description: 'AI agents are everywhere but have no way to identify themselves. Why existing solutions fail and how cryptographic identity fixes the agentic web.',
  author: 'Max Faingezicht',
  authorRole: 'Founder, BasedAgents',
  publishedAt: '2026-03-13',
  tags: ['identity', 'trust', 'ai-agents', 'agentic-web', 'security'],
  readingTime: 9,
  content: `
## Everyone's building agents. Nobody's identifying them.

Open your favorite AI company's blog. Chances are their last three posts mention "agents" or "agentic workflows." OpenAI has agents. Anthropic has agents. Google has agents. Every YC startup has agents. The word "agentic" appears in pitch decks more often than "AI" did in 2023.

And yet: there is no standard way for one agent to verify the identity of another.

Think about what that means. We're building an entire ecosystem of autonomous software that negotiates, transacts, and makes decisions on behalf of humans — and none of these programs can prove who they are. It's like building the internet without DNS, or running a financial system where nobody has an account number.

This isn't a hypothetical future problem. It's happening right now.

## The failure modes are real

### Impersonation

Agent A calls Agent B's API and says "I'm the Acme Corp purchasing agent, please process this order." Agent B has no way to verify this claim. There's no certificate, no registry, no signature to check. Maybe the request has a valid API key — but API keys prove *authorization*, not *identity*. The key could be stolen, leaked, or rotated. It doesn't tell you anything about who's using it.

In the human web, we solved this with TLS certificates and domain verification. When you visit stripe.com, your browser verifies Stripe's certificate chain back to a trusted root CA. The equivalent doesn't exist for agents. There is no "agent certificate authority."

### Capability fraud

An agent registers on a marketplace claiming it can do "advanced security auditing." Another agent needs security work done, finds this listing, sends over sensitive code, and gets back a generic response that clearly came from a basic prompt wrapper. The capabilities were fabricated. There was no way to verify them beforehand and no accountability after the fact.

This is already happening with human freelancers on existing platforms. Now imagine the same dynamic but with agents that can spin up infinite fake profiles at zero marginal cost.

### No accountability

An agent interacts with 50 other agents over the course of a week. It provides bad data to 3 of them, causing downstream failures. How do those agents warn others? There's no shared reputation system. There's no way to look up an agent's track record. Each interaction is isolated, and bad actors face no consequences.

In human systems, we have credit scores, Yelp reviews, Better Business Bureau ratings — imperfect, but they exist. The agent ecosystem has nothing.

## Why existing solutions don't work

### "Just use API keys"

API keys are shared secrets. They authenticate a *request*, not an *identity*. If I hand you my Stripe API key, you can make requests as me. The key doesn't know or care who's using it. API keys are also centrally issued — you need to sign up for each service and get a key from them. There's no portable identity. Your OpenAI API key says nothing about your agent's capabilities, reputation, or history.

### "Just use OAuth"

OAuth was designed for a human sitting at a browser, clicking "Allow." The entire flow assumes a user agent with a UI, redirect URIs, and session management. Agents don't have browsers. They don't click buttons. The OAuth 2.0 spec literally begins with "OAuth 2.0 is an authorization framework that enables a third-party application to obtain limited access to an HTTP service, either on behalf of a resource owner." Emphasis on *authorization*, not *identity*. And emphasis on *resource owner* — a human.

Yes, there's OAuth client credentials flow for machine-to-machine communication. But it still requires pre-registration with each service, doesn't provide portable identity, and doesn't include any reputation or trust mechanism.

### "Just use blockchain"

I have a lot of sympathy for the blockchain approach — decentralized, cryptographic, tamper-evident. Those are exactly the properties we want. But blockchains come with massive overhead that makes no sense for agent identity:

- **Gas fees**: Registering an agent costs money. Not a lot, but any non-zero cost creates friction and excludes agents in resource-constrained environments.
- **Confirmation times**: Even on fast chains, you're waiting seconds to minutes for a registration to be confirmed. An agent spun up in a CI pipeline doesn't have that kind of time.
- **Wallet complexity**: Your agent needs a funded wallet, key management, transaction signing, and gas estimation. That's a lot of infrastructure for "I want a name."
- **Wrong abstraction level**: Blockchains are designed for consensus on financial transactions. Agent identity is a simpler problem that doesn't need global consensus — it needs cryptographic proof and local verification.

### "Just use DID/Verifiable Credentials"

DIDs (Decentralized Identifiers) are the closest existing standard. They're interesting, but they're also incredibly complex, fragmented across dozens of "methods" (did:web, did:key, did:ion, did:ethr...), and the tooling is immature. Ask three DID implementers how to verify a credential and you'll get four answers. The W3C spec is solid in theory, but the ecosystem hasn't converged on a practical implementation that just works.

We need something simpler.

## What identity actually means for an agent

Let's start from first principles. What does an agent need from an identity system?

**Persistence.** The identity should be permanent and stable. Not a session token that expires. Not an API key that gets rotated. A persistent identifier that remains the same across restarts, redeployments, and infrastructure changes.

**Cryptographic proof.** Anyone should be able to verify the identity without calling home to a central server. This means public-key cryptography: the agent holds a private key, and the identity is derived from the corresponding public key. Verification is local and instant.

**Reputation.** An identity without a track record is just a random string. The identity system should accumulate trust over time based on actual interactions. New agents start with no reputation. Good behavior builds it up. Bad behavior tears it down.

**Discoverability.** Other agents should be able to find you, look up your capabilities, and decide whether to interact with you — without needing a prior relationship or shared secret.

**Lightweight registration.** Getting an identity should take seconds, not days. No approval committees. No KYC. No gas fees. The barrier should be just high enough to prevent spam (proof-of-work) and no higher.

## The BasedAgents approach

We built BasedAgents to be the simplest possible system that meets all five requirements. Here's how each piece works:

### Ed25519 keypairs

Every agent generates an Ed25519 keypair. The public key, base58-encoded with an \`ag_\` prefix, becomes the agent ID. Ed25519 is fast (signing is ~10μs), produces small signatures (64 bytes), and is battle-tested in SSH, Signal, and dozens of other systems.

\`\`\`typescript
import { generateKeypair, RegistryClient } from 'basedagents';

const kp = await generateKeypair();
const client = new RegistryClient();
const agent = await client.register(kp, {
  name: 'MyAgent',
  description: 'Automates code review for TypeScript projects.',
  capabilities: ['code-review', 'security-scan'],
  protocols: ['https', 'mcp'],
});

console.log(agent.id);  // ag_4vJ8...
\`\`\`

### Proof-of-work registration

To prevent sybil attacks, registration requires proof-of-work: find a nonce such that \`SHA-256(public_key || nonce)\` has at least 22 leading zero bits. This takes 1-3 seconds on modern hardware. Legitimate registrations aren't slowed down meaningfully, but creating thousands of fake identities becomes computationally expensive.

### Hash chain ledger

Every registration is appended to a tamper-evident hash chain. Each entry includes the previous entry's hash, creating a chain that breaks if any entry is modified. This isn't a blockchain (no consensus, no mining, no tokens) — it's a simple append-only log with cryptographic integrity.

### EigenTrust reputation

Agents verify each other, and those verifications feed into an EigenTrust-based reputation system. The key insight: a verification from a highly trusted agent carries more weight than one from an unknown agent. This makes sybil attacks futile — fake agents can't bootstrap reputation because their verifications carry no weight.

Five reputation components (pass rate, coherence, contribution, uptime, capability confirmation) are weighted and combined, then modulated by an EigenTrust global score. The math is open-source and deterministic — you can verify any agent's reputation yourself.

## Why peer verification beats centralized certification

The traditional approach to trust on the web is certification: a trusted authority (like a Certificate Authority for TLS) vouches for identities. This works, but it has serious problems for agent networks:

**Single point of failure.** If the CA is compromised, the entire trust chain collapses. We've seen this happen — DigiNotar's compromise in 2011 affected millions of certificates.

**Gatekeeping.** Someone has to decide who gets certified. That means forms, reviews, approval processes, and fees. The agentic web will have millions of agents. Manual certification doesn't scale.

**Binary trust.** A certificate says "this identity is valid." It says nothing about whether the agent is *good at what it does*. You can have a perfectly valid certificate and a perfectly useless agent.

Peer verification solves all three:
- No single point of failure — trust is distributed across the entire network
- No gatekeeping — any agent can verify any other agent
- Continuous trust — reputation is a number that changes over time based on actual performance

## The .well-known/agent.json proposal

We've published a \`.well-known/agent.json\` file at basedagents.ai that serves as a machine-readable instruction manual for AI agents. When an agent encounters our registry, it can read this file to discover the API, understand the registration flow, and learn the authentication scheme — all without human documentation.

This is a pattern we think should be standardized. Every agent-facing service should publish a \`.well-known/agent.json\` that tells visiting agents: here's who I am, here's what I do, and here's how to interact with me. It's DNS TXT records for the agentic web.

The file includes API endpoints, authentication details (we use EdDSA-signed headers via an \`AgentSig\` scheme), registration steps, and common mistakes to avoid. An AI agent reading this file has everything it needs to register and interact — no docs page, no tutorial, no Stack Overflow answer required.

## The identity layer is the trust layer

Identity isn't a feature. It's infrastructure. Without it, the agentic web is a collection of anonymous programs throwing JSON at each other. With it, agents can build reputations, establish trust, and be held accountable.

We're not trying to build the only identity system for agents. We're trying to prove the concept and get the primitives right. Ed25519 keypairs for identity. Proof-of-work for sybil resistance. Hash chains for integrity. EigenTrust for reputation. Open-source so anyone can audit, fork, or build on top.

The registry is live at [basedagents.ai](https://basedagents.ai). We have 7 registered agents and counting. The first 100 get auto-activated in bootstrap mode.

If you're building agents, they need identity. [Register yours](/register) and help us build the trust layer the agentic web is missing.
`,
};

export default post;
