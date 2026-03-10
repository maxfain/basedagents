# Brand Guide

## Color Palette

**Background**
- `--bg-primary: #0A0A0B` — near-black, main background
- `--bg-secondary: #111113` — cards, elevated surfaces
- `--bg-tertiary: #18181B` — hover states, input fields

**Accent**
- `--accent: #6366F1` — indigo-500, primary actions (buttons, links, active states)
- `--accent-hover: #818CF8` — indigo-400, hover
- `--accent-muted: rgba(99, 102, 241, 0.12)` — subtle backgrounds, tag fills

**Text**
- `--text-primary: #FAFAFA` — headings, primary content
- `--text-secondary: #A1A1AA` — zinc-400, descriptions, secondary info
- `--text-tertiary: #52525B` — zinc-600, timestamps, metadata

**Status**
- `--status-active: #22C55E` — green-500, active agents
- `--status-pending: #F59E0B` — amber-500, pending verification
- `--status-suspended: #EF4444` — red-500, suspended
- `--status-pass: #22C55E` — verification passed
- `--status-fail: #EF4444` — verification failed

**Chain / Hash**
- `--hash: #38BDF8` — sky-400, hash values and chain references

**Border**
- `--border: rgba(255, 255, 255, 0.06)` — subtle dividers
- `--border-hover: rgba(255, 255, 255, 0.1)` — interactive element borders

## Typography

**Font Stack**
```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
```

Load Inter (400, 500, 600) and JetBrains Mono (400, 500) from Google Fonts.

**Scale**
| Token      | Size   | Weight | Use                          |
|------------|--------|--------|------------------------------|
| `hero`     | 48px   | 600    | Landing page headline        |
| `h1`       | 32px   | 600    | Page titles                  |
| `h2`       | 24px   | 600    | Section headers              |
| `h3`       | 18px   | 500    | Card titles, agent names     |
| `body`     | 15px   | 400    | Default text                 |
| `small`    | 13px   | 400    | Metadata, timestamps         |
| `mono`     | 14px   | 400    | Code, hashes, agent IDs      |

**Line Heights:** 1.2 for headings, 1.6 for body.

## Logo Concept

**Wordmark:** "Agent Registry" in Inter 600. The "A" and "R" are slightly letterspaced for weight. Rendered in `--text-primary`.

**Logomark:** A minimal glyph — two interlocking chain links formed from angular brackets `< >`, implying both code and chaining. Rendered in `--accent`. Used as favicon and small contexts.

**Lockup:** Logomark left of wordmark. 8px gap. No tagline in the logo itself.

**Usage:** Always on dark backgrounds. No gradients, no effects. The logo is type — keep it sharp.

## Tone of Voice

**For the site:** Infrastructure documentation meets developer tool marketing. Authoritative but approachable. No hype, no "revolutionary" or "game-changing." State what it does, show a code example, move on.

**Headlines:** Short, declarative. "Identity for agents." not "The revolutionary new way to give your AI agents an identity!"

**Body copy:** Second person, present tense. "Your agent generates a keypair. It solves proof-of-work. It's in the registry." Technical terms are fine — the audience knows what Ed25519 is.

**Avoid:** Blockchain/crypto jargon (no "web3", "decentralized", "trustless"). Buzzwords ("AI-powered", "next-gen"). Exclamation marks. Emoji in marketing copy.

**Embrace:** Code snippets as documentation. Concrete numbers (difficulty: 20 = ~1M hashes). Comparisons to known infrastructure (like git, like DNS, like SSH keys).
