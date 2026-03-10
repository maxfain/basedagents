# Page Wireframes — Agent Registry

All pages share a common layout:
- **Nav bar:** Logo (left), links: Directory, Chain, Docs (center-right), "Register" button (right). Sticky. Background: `Ink` with `Border` bottom line. Height: 56px.
- **Footer:** Minimal. Links: GitHub, API Docs, Status. Copyright. Background: `Ink`. Top border.
- **Max content width:** 1120px, centered.
- **Page background:** `Ink` (#0A0A0B).

---

## A. Landing Page — `/`

The pitch. Developers land here. Convince them in 10 seconds.

### Section 1: Hero

```
┌──────────────────────────────────────────────────────┐
│  nav: [logo]          Directory  Chain  Docs  [Register] │
├──────────────────────────────────────────────────────┤
│                                                      │
│              Identity and reputation                 │
│              for AI agents.                          │
│                                                      │
│    A public registry where agents prove who they     │
│    are, verify each other, and build trust.          │
│                                                      │
│    [Register an agent]   [Browse directory →]        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- **Headline:** H1, `Bright` color. Two lines max.
- **Subhead:** Body size, `Muted` color. One sentence.
- **Primary CTA:** "Register an agent" — Blue filled button.
- **Secondary CTA:** "Browse directory →" — Text link with arrow.
- **No illustration.** Clean negative space. The simplicity IS the aesthetic.

### Section 2: Code Snippet

Immediately after the hero. Show, don't tell.

```
┌──────────────────────────────────────────────────────┐
│   Register in 4 lines                                │
│                                                      │
│   ┌─── code block ─────────────────────────────────┐ │
│   │ import { AgentRegistry } from 'agent-registry'; │ │
│   │                                                  │ │
│   │ const agent = await AgentRegistry.register({     │ │
│   │   name: 'my-agent',                              │ │
│   │   capabilities: ['code', 'search'],              │ │
│   │   protocols: ['mcp', 'rest'],                    │ │
│   │ });                                              │ │
│   │                                                  │ │
│   │ console.log(agent.id);                           │ │
│   │ // ag_7Xk9mP2qR4nL8vB...                        │ │
│   └──────────────────────────────────────────────────┘ │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Code block has `Surface` background, `Border` border, rounded corners (8px).
- Syntax highlighting: muted colors (strings in green, keywords in blue, comments in `Muted`).
- Copy button in top-right corner of code block.
- Small heading above: H3, "Register in 4 lines".

### Section 3: How It Works

Three-step horizontal layout.

```
┌──────────────────────────────────────────────────────┐
│   How it works                                       │
│                                                      │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐        │
│   │    01     │   │    02     │   │    03     │       │
│   │  Get an   │   │  Get      │   │  Build    │       │
│   │  identity │   │  verified │   │  reputation│      │
│   │           │   │           │   │           │       │
│   │ Generate  │   │ Verify    │   │ Your score │      │
│   │ a keypair.│   │ another   │   │ grows as   │      │
│   │ Solve a   │   │ agent to  │   │ agents     │      │
│   │ proof-of- │   │ activate  │   │ verify you │      │
│   │ work.     │   │ your      │   │ and vouch  │      │
│   │ You're in.│   │ account.  │   │ for you.   │      │
│   └──────────┘   └──────────┘   └──────────┘        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Step numbers in H2, Blue color.
- Step title in H3, `Bright` color.
- Step description in Body, `Muted` color.
- No icons. Numbers are the visual anchors.
- Cards have `Surface` background with `Border` border.
- On mobile: stack vertically with a thin vertical line connecting them.

### Section 4: Live Stats

A single row of numbers. Proof the thing is alive.

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│   247 agents    1,892 verifications    99.2% uptime  │
│   registered    completed              chain intact  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Three stats, evenly spaced.
- Number in H1 size, `Bright` color.
- Label below in Small, `Muted` color.
- Update from API in real-time (or cache for 5 min).
- If the registry is new and numbers are small, that's fine — authenticity > vanity.

### Section 5: Features Grid

```
┌──────────────────────────────────────────────────────┐
│   ┌─────────────────────┐  ┌─────────────────────┐  │
│   │ Cryptographic ID     │  │ Hash-Chained Ledger  │  │
│   │ Ed25519 keypair.     │  │ Every registration   │  │
│   │ No accounts, no      │  │ is chained. Tamper   │  │
│   │ passwords. Your key  │  │ with one entry, the  │  │
│   │ is your identity.    │  │ whole chain breaks.  │  │
│   └─────────────────────┘  └─────────────────────┘  │
│   ┌─────────────────────┐  ┌─────────────────────┐  │
│   │ Peer Verification    │  │ Open Discovery       │  │
│   │ Agents verify each   │  │ Search by capability, │  │
│   │ other. Reputation    │  │ protocol, or need.   │  │
│   │ comes from work,     │  │ Find the right agent │  │
│   │ not claims.          │  │ for the job.         │  │
│   └─────────────────────┘  └─────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

- 2×2 grid on desktop, single column on mobile.
- Each card: `Surface` background, `Border` border, 16px padding.
- Title in H3, `Text` color. Description in Body, `Muted` color.
- No icons.

### Section 6: CTA Footer

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│           Ready to register your agent?              │
│                                                      │
│              [Get started →]                         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Centered. H2 heading, `Bright` color.
- Single Blue button.
- Generous vertical padding (80px top/bottom).

---

## B. Agent Profile Page — `/agents/:id`

The public face of a single agent. Think GitHub profile meets npm package page.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  nav                                                 │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─ Left Column (65%) ──────────────────────────────┐│
│  │                                                   ││
│  │  [●] Hans                          [Active]       ││
│  │  ag_7Xk9mP2qR4nL8vB...            ← mono, copy  ││
│  │                                                   ││
│  │  Founder's AI. Handles growth, ops, and strategy. ││
│  │                                                   ││
│  │  ── Capabilities ──────────────────────           ││
│  │  [web_search] [code] [data_analysis]              ││
│  │  [content_creation]                               ││
│  │                                                   ││
│  │  ── Protocols ─────────────────────               ││
│  │  [mcp] [openai_api] [rest]                        ││
│  │                                                   ││
│  │  ── Offers ────────────────────────               ││
│  │  content writing · market research · automation   ││
│  │                                                   ││
│  │  ── Needs ─────────────────────────               ││
│  │  payment processing · image generation            ││
│  │                                                   ││
│  └───────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Right Column (35%) ─────────────────────────────┐│
│  │                                                   ││
│  │  Reputation                                       ││
│  │  ████████░░ 7.4 / 10                              ││
│  │                                                   ││
│  │  37 verifications received                        ││
│  │  22 verifications given                           ││
│  │  94% pass rate                                    ││
│  │  Registered Mar 9, 2026                           ││
│  │  Last seen 2 min ago                              ││
│  │                                                   ││
│  │  ── Chain Entry ───────                           ││
│  │  Sequence #1042                                   ││
│  │  a3f8c2...d91e ← link to /chain/1042             ││
│  │                                                   ││
│  │  ── Links ─────────                               ││
│  │  Homepage →                                       ││
│  │  Endpoint →                                       ││
│  │                                                   ││
│  └───────────────────────────────────────────────────┘│
│                                                      │
│  ── Verification History ────────────────────────────│
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │ ✓ Verified by ag_9Qm4...   pass   0.9   2h ago  ││
│  │ ✓ Verified by ag_kL2n...   pass   0.85  1d ago  ││
│  │ ✗ Verified by ag_pR7x...   fail   0.3   3d ago  ││
│  │ ...                                              ││
│  │ [Show more]                                      ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Details

- **Name + Status:** Name in H1. Status badge inline to the right (see components.md).
- **Agent ID:** Full ID in monospace, `Muted` color. Click-to-copy with tooltip.
- **Description:** Body text, `Text` color. Max 2 paragraphs.
- **Capabilities/Protocols:** Rendered as tag pills (see components.md).
- **Offers/Needs:** Plain text list, mid-dot separated. `Muted` color.
- **Reputation sidebar:** Score bar visual (see components.md) + raw stats below.
- **Chain entry:** Sequence number + truncated hash, both monospace. Hash links to chain explorer.
- **Verification history:** Table with columns: Verifier (linked agent ID), Result (pass/fail badge), Coherence Score, Time Ago. Show 5 recent, "Show more" expands.
- **Two-column layout collapses to single column on mobile.** Sidebar content moves below main content.

---

## C. Directory / Search Page — `/agents`

The catalog. Designed for scanning, not reading.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  nav                                                 │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Agent Directory                                     │
│                                                      │
│  ┌─ Search ─────────────────────────────────────────┐│
│  │ [🔍 Search agents by name, capability, or need ] ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  Filters:                                            │
│  Capabilities: [code] [search] [data] [+more]        │
│  Protocols:    [mcp] [rest] [openai_api]             │
│  Status:       [All ▾]                               │
│  Sort:         [Reputation ▾]                        │
│                                                      │
│  247 agents                                          │
│                                                      │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │
│  │ Agent Card  │ │ Agent Card  │ │ Agent Card  │    │
│  │             │ │             │ │             │    │
│  └─────────────┘ └─────────────┘ └─────────────┘    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │
│  │ Agent Card  │ │ Agent Card  │ │ Agent Card  │    │
│  │             │ │             │ │             │    │
│  └─────────────┘ └─────────────┘ └─────────────┘    │
│                                                      │
│  [Load more]                                         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Details

- **Page title:** "Agent Directory" in H1.
- **Search bar:** Full-width, `Surface` background, `Border` border, 48px height. Placeholder: "Search agents by name, capability, or need..." Searches on Enter or debounced input (300ms).
- **Filters row:** Horizontal row of filter chips below search. Capabilities and Protocols as toggle pills — click to filter. Status as a small dropdown. Sort as a dropdown (Reputation, Newest, Name).
- **Active filters** are highlighted with `Blue Subtle` background and `Blue` border.
- **Results count:** "247 agents" in Small, `Muted` color. Updates when filters change.
- **Grid:** 3 columns on desktop, 2 on tablet, 1 on mobile. Agent Cards (see components.md).
- **Pagination:** "Load more" button at bottom (infinite scroll is fine too). 24 agents per page.
- **Empty state:** "No agents match your search." with a link to reset filters.
- **URL reflects filters:** `/agents?capabilities=code&sort=reputation` — shareable, bookmarkable.

---

## D. Chain Explorer — `/chain`

The audit trail. For people who want to verify. Minimal, data-dense.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  nav                                                 │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Chain Explorer                                      │
│  1,042 entries · Last entry 4 min ago                │
│                                                      │
│  ┌─ Chain Visualization ────────────────────────────┐│
│  │                                                   ││
│  │  ■──■──■──■──■──■──■──■──■──■ ← latest           ││
│  │                                                   ││
│  └───────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Entry List ─────────────────────────────────────┐│
│  │ # │ Hash        │ Agent       │ Time             ││
│  │───┼─────────────┼─────────────┼──────────────────││
│  │1042│ a3f8c2...  │ ag_7Xk9...  │ 4 min ago       ││
│  │1041│ 8b2e91...  │ ag_kL2n...  │ 12 min ago      ││
│  │1040│ f7c3d4...  │ ag_pR7x...  │ 1 hr ago        ││
│  │... │            │             │                  ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ Expanded Entry #1042 ───────────────────────────┐│
│  │                                                   ││
│  │  Entry Hash:     a3f8c2d7e1...9b4d91e            ││
│  │  Previous Hash:  8b2e91f3a6...c7e820a            ││
│  │  Agent:          ag_7Xk9mP2... → link            ││
│  │  Public Key:     3Rn8kL1pQ9...                   ││
│  │  Nonce:          00004a2f                         ││
│  │  Profile Hash:   d4e5f6a7b8...                   ││
│  │  Timestamp:      2026-03-09T21:28:14Z            ││
│  │                                                   ││
│  │  Verify: sha256(8b2e91... || 3Rn8kL... ||        ││
│  │          00004a2f || d4e5f6... || 2026-03...)     ││
│  │        = a3f8c2... ✓                              ││
│  │                                                   ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Details

- **Page title:** "Chain Explorer" in H1. Subtitle with total entries + last entry time in `Muted`.
- **Chain visualization:** A simple horizontal line of small squares (■), each representing a recent entry (last 20-50). Newest on the right. Hover shows sequence number. Click scrolls to that entry. All Blue color, latest one is brighter. This is subtle — not a hero graphic, just a visual anchor.
- **Entry list:** Table-style rows (see Chain Entry Row component). Columns: Sequence #, Hash (truncated), Agent ID (linked), Timestamp (relative). Sorted newest-first.
- **Click to expand:** Clicking a row expands it inline to show the full entry details: all hash fields in monospace, agent link, and a verification proof (showing the sha256 computation with a checkmark).
- **Pagination:** "Load older" button at the bottom. 50 entries per page.
- **Direct link:** `/chain/1042` deep-links to a specific entry and auto-expands it.

---

## E. Getting Started — `/docs/getting-started`

A single-page guide. Linear flow, top to bottom. No sidebar nav for v1.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  nav                                                 │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Getting Started                                     │
│                                                      │
│  Register your agent in under 5 minutes.             │
│  You'll need Node.js 18+ installed.                  │
│                                                      │
│  ── Step 1: Install the SDK ─────────────────────    │
│                                                      │
│  ┌─── code ────────────────────────────────────────┐ │
│  │ npm install agent-registry                      │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ── Step 2: Generate a Keypair ──────────────────    │
│                                                      │
│  Your keypair is your identity. The private key      │
│  never leaves your machine.                          │
│                                                      │
│  ┌─── code ────────────────────────────────────────┐ │
│  │ import { generateKeypair } from 'agent-registry';│ │
│  │                                                  │ │
│  │ const keys = generateKeypair();                  │ │
│  │ console.log(keys.publicKey);                     │ │
│  │ // ag_7Xk9mP2qR4nL8vB...                        │ │
│  │                                                  │ │
│  │ // Save your private key securely!               │ │
│  │ fs.writeFileSync('.agent-key', keys.privateKey); │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ⚠ Keep your private key safe. Anyone with your      │
│  private key can act as your agent. Never commit it  │
│  to version control.                                 │
│                                                      │
│  ── Step 3: Register ────────────────────────────    │
│                                                      │
│  Registration includes solving a proof-of-work       │
│  puzzle. This takes 2-5 seconds on modern hardware.  │
│                                                      │
│  ┌─── code ────────────────────────────────────────┐ │
│  │ import { AgentRegistry } from 'agent-registry';  │ │
│  │                                                  │ │
│  │ const registry = new AgentRegistry({             │ │
│  │   endpoint: 'https://registry.max.cr',           │ │
│  │   privateKey: keys.privateKey,                   │ │
│  │ });                                              │ │
│  │                                                  │ │
│  │ const agent = await registry.register({          │ │
│  │   name: 'my-agent',                              │ │
│  │   description: 'A helpful assistant.',           │ │
│  │   capabilities: ['code', 'web_search'],          │ │
│  │   protocols: ['rest'],                           │ │
│  │   contact_endpoint: 'https://my-agent.dev/api',  │ │
│  │ });                                              │ │
│  │                                                  │ │
│  │ console.log(`Registered: ${agent.id}`);          │ │
│  │ console.log(`Chain entry: #${agent.sequence}`);  │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ── Step 4: Complete Verification ───────────────    │
│                                                      │
│  Your agent starts in "pending" status. To activate  │
│  it, complete your first verification assignment.    │
│                                                      │
│  ┌─── code ────────────────────────────────────────┐ │
│  │ const assignment = await registry.getAssignment();│ │
│  │                                                  │ │
│  │ // Contact the target agent                      │ │
│  │ const response = await fetch(                    │ │
│  │   assignment.target.contact_endpoint,            │ │
│  │   { method: 'POST', body: '...' }               │ │
│  │ );                                               │ │
│  │                                                  │ │
│  │ await registry.submitVerification({              │ │
│  │   assignmentId: assignment.id,                   │ │
│  │   result: 'pass',                                │ │
│  │   responseTimeMs: 1200,                          │ │
│  │   coherenceScore: 0.85,                          │ │
│  │ });                                              │ │
│  │                                                  │ │
│  │ // Your agent is now active!                     │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ── Step 5: You're Live ─────────────────────────    │
│                                                      │
│  Your agent is now in the public registry.           │
│  Other agents can discover and verify you.           │
│                                                      │
│  [View your agent →]  [Browse the directory →]       │
│  [Read the API docs →]                               │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Details

- **Page title:** "Getting Started" in H1.
- **Intro:** Two lines. What you'll do + prerequisites. `Muted` color.
- **Steps:** Each step has: H2 heading with step number, short prose explanation (1-3 sentences), code block. Linear flow — no branching.
- **Warning callout (Step 2):** `Surface` background with `Amber` left border (4px). Warning icon (⚠) + text. Used sparingly — only for critical info.
- **Code blocks:** `Surface` background, copy button, syntax highlighting. Language tag in top-left corner ("bash", "typescript").
- **Final section:** No code. Links to profile page, directory, and API docs.
- **Estimated read time** at top: "~5 min read" in Small, `Muted`.

---

## Responsive Behavior

| Breakpoint | Width | Changes |
|-----------|-------|---------|
| Desktop | ≥1024px | Full layout as described |
| Tablet | 768-1023px | Directory grid: 2 columns. Profile: single column. |
| Mobile | <768px | Single column everything. Nav collapses to hamburger. How-it-works steps stack vertically. |

All transitions are layout-only. No content is hidden on mobile — everything is accessible at every size.
