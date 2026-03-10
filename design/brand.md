# Brand Guide — Agent Registry

## Color Palette

A dark, neutral foundation with a single accent color. No gradients, no neon, no rainbow. Think: the confidence of a well-lit terminal.

### Primary

| Name | Hex | Usage |
|------|-----|-------|
| **Ink** | `#0A0A0B` | Page background, primary dark |
| **Surface** | `#141416` | Card backgrounds, elevated surfaces |
| **Border** | `#1E1E22` | Borders, dividers, subtle separation |
| **Muted** | `#63636E` | Secondary text, labels, placeholders |
| **Text** | `#EDEDEF` | Primary text |
| **Bright** | `#FAFAFA` | Headings, emphasis text |

### Accent

| Name | Hex | Usage |
|------|-----|-------|
| **Blue** | `#3B82F6` | Links, primary actions, interactive elements |
| **Blue Subtle** | `#3B82F61A` | Hover states, selected backgrounds (blue @ 10% opacity) |
| **Blue Muted** | `#3B82F640` | Focus rings, active indicators (blue @ 25% opacity) |

### Semantic

| Name | Hex | Usage |
|------|-----|-------|
| **Green** | `#22C55E` | Active status, pass results, positive signals |
| **Amber** | `#F59E0B` | Pending status, warnings |
| **Red** | `#EF4444` | Suspended status, fail results, errors |

### Usage Rules

- **Background is always Ink or Surface.** No light mode for v1.
- **Blue is the only accent.** Don't introduce purple, teal, or orange for "variety."
- **Semantic colors appear only in status/result contexts.** Never decorative.
- **Borders are subtle.** 1px, Border color. They define space, not draw attention.

---

## Typography

System font stack with a monospace companion. No custom font loading for v1 — speed matters.

### Font Stack

```css
--font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
--font-mono: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', 'Courier New', monospace;
```

If we add a Google Font later, **Inter** for sans and **JetBrains Mono** for code.

### Scale

| Level | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| **H1** | 40px / 2.5rem | 600 | 1.2 | Page titles |
| **H2** | 28px / 1.75rem | 600 | 1.3 | Section headings |
| **H3** | 20px / 1.25rem | 500 | 1.4 | Card titles, subsections |
| **Body** | 15px / 0.9375rem | 400 | 1.6 | Paragraphs, descriptions |
| **Small** | 13px / 0.8125rem | 400 | 1.5 | Labels, metadata, captions |
| **Mono** | 14px / 0.875rem | 400 | 1.6 | Code, agent IDs, hashes |

### Rules

- **Headings use weight 500-600.** Never bold (700+) — it feels loud.
- **Body text is always `Text` color.** Never pure white (`#FFF`).
- **Agent IDs and hashes always render in monospace.** They're identifiers, not prose.
- **Letter-spacing on headings:** `-0.02em` (slight tightening, like Linear/Vercel).
- **Max paragraph width:** `640px` (readable line length).

---

## Logo Concept

**Text mark only.** No icon, no symbol, no mascot. The name does the work.

### The Mark

```
agent registry
```

- All lowercase. No camel case, no title case.
- Set in the sans-serif stack, weight 500.
- Two words, no separator.
- "agent" in `Text` color (#EDEDEF), "registry" in `Muted` color (#63636E).
- The weight difference creates hierarchy without adding visual noise.

### Compact Form

```
ag_
```

- Used in favicons, small contexts, and as a prefix motif.
- Rendered in monospace, Blue accent color.
- Mirrors the agent ID format (`ag_7Xk9mP2...`) — the product IS the brand.

### Logo Don'ts

- No icons, shields, chains, or nodes. These scream web3.
- No all-caps. We're infrastructure, not a defense contractor.
- No tagline in the logo. Taglines live in copy, not identity.

---

## Tone of Voice

### Principles

1. **Technical but not academic.** Write like you're explaining it to a senior engineer, not a professor. Use precise terms but skip the formalism.

2. **Confident, not hype.** State what it does. Don't say "revolutionary" or "cutting-edge." The tech speaks for itself.

3. **Direct.** Short sentences. Active voice. Lead with the verb or the result, not the preamble.

4. **Developer-first.** Show code before explaining concepts. Developers read code faster than prose.

### Examples

**Good:**
> Register your agent in three lines of code. Identity is a keypair — no accounts, no API keys.

**Bad:**
> The Agent Registry provides a groundbreaking decentralized identity solution that leverages cutting-edge cryptographic primitives to enable seamless agent-to-agent trust establishment.

**Good:**
> Reputation is earned, not declared. Agents verify each other and build trust through work.

**Bad:**
> Our innovative peer-verification mechanism facilitates organic trust network formation through bidirectional capability assessment protocols.

### Words We Use

- register, identity, verify, reputation, discover, search, chain, sign
- agent, profile, capability, protocol, endpoint
- public, open, verifiable, tamper-evident

### Words We Don't Use

- decentralized, blockchain, web3, token, stake, mint, burn
- revolutionary, game-changing, disruptive, next-gen
- AI-powered (everything is AI here — it's redundant)
- enterprise-grade, world-class, best-in-class

### Copy Patterns

- **CTAs:** "Register an agent" / "Search the registry" / "View the chain" — verb + object, no fluff.
- **Descriptions:** Lead with what it does, then how. "Every registration is hash-chained into a public ledger. Anyone can verify the full history."
- **Error messages:** Say what happened and what to do. "Invalid signature. Make sure you're signing with the private key that matches this agent ID."
