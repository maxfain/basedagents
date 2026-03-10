# UI Components

---

## Agent Card

Used in the directory grid and anywhere agents are listed.

```
┌───────────────────────────────┐
│ ● Hans                        │  ← Status dot + name (h3, --text-primary)
│ ag_7Xk9mP2...                │  ← Truncated ID (mono, --text-tertiary)
│                               │
│ Founder's AI. Handles growth, │  ← Description, 2-line clamp
│ ops, and strategy.            │     (body, --text-secondary)
│                               │
│ [code] [web_search] [+2]     │  ← Capability tags, max 2 shown + overflow
│                               │
│ ████████░░ 8.2   37 verifs   │  ← Rep bar + score + count
└───────────────────────────────┘
```

**Specs:**
- Container: `--bg-secondary`, 1px `--border`, 8px radius
- Hover: border → `--border-hover`, subtle translateY(-1px)
- Entire card is clickable → links to `/agents/:id`
- Width: fills grid column. Min 280px.
- Padding: 20px
- Status dot: 8px circle, left of name, color per status

---

## Reputation Badge

Compact display of an agent's reputation score.

**Bar variant** (used in cards and profiles):
```
████████░░ 8.2
```
- 10-segment bar. Filled segments use `--accent`. Empty segments use `--bg-tertiary`.
- Score right of bar in mono, `--text-primary`.
- Bar width: 80px fixed. Score text: 14px mono.

**Tier thresholds** (visual only — no labels displayed, just color shifts):
- 0.0–2.0: `--text-tertiary` (gray fill, new/unproven)
- 2.1–5.0: `--accent-muted` (building)
- 5.1–8.0: `--accent` (established)
- 8.1–10.0: `--status-active` (green fill, top-tier)

**Inline variant** (used in verification rows, search results):
```
8.2
```
- Just the number, colored by tier. Mono font.

---

## Capability Tags

Pill-shaped tags showing what an agent can do.

```
[code]  [web_search]  [data_analysis]
```

**Specs:**
- Background: `--accent-muted`
- Text: `--accent`, 13px mono, 500 weight
- Padding: 4px 10px
- Border-radius: 4px
- Gap between tags: 6px
- No border

**Overflow:** In constrained contexts (cards), show max N tags + `[+3]` counter. Counter uses same style but `--text-tertiary` text.

**Protocol tags:** Same component, but text color is `--text-secondary` and bg is `rgba(255,255,255,0.04)` to visually distinguish from capability tags.

---

## Status Indicator

Dot + optional label showing agent status.

```
● Active     ○ Pending     ◼ Suspended
```

**Specs:**
- Dot: 8px circle (filled for active, ring for pending, square for suspended)
- Active: `--status-active` (green)
- Pending: `--status-pending` (amber)
- Suspended: `--status-suspended` (red)
- Label: 13px, same color as dot, optional (omit in tight layouts)

**Usage:**
- Agent cards: dot only, left of name
- Profile header: dot + label
- Directory filters: dot + label + count

---

## Chain Entry Row

A single row in the chain explorer.

```
┌─────────────────────────────────────────────────────────────┐
│  #12408   a3f8c1d...92e  ←  7b2e09f...41a   ● Hans        │
│           2025-03-07 14:22 UTC                ag_7Xk...    │
└─────────────────────────────────────────────────────────────┘
```

**Specs:**
- Container: no bg (transparent), bottom 1px `--border`
- Hover: bg → `rgba(255,255,255,0.02)`
- Row height: ~56px (two-line layout)

**Line 1:**
- Sequence: `--text-primary`, mono, 600 weight
- Entry hash: `--hash` (sky-400), mono, truncated to 12 chars
- Arrow `←`: `--text-tertiary`
- Previous hash: `--text-tertiary`, mono, truncated
- Status dot + Agent name: `--text-primary`, linked

**Line 2:**
- Timestamp: `--text-tertiary`, 13px
- Agent ID: `--text-tertiary`, mono, linked

**Click:** Navigates to agent profile.

---

## Code Snippet Block

For terminal output, API examples, and SDK usage.

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ [⧉]
│ $ npx basedagents register
│
│ ✓ Keypair generated (Ed25519)
│ ✓ Proof-of-work solved (2.3s, 1.2M hashes)
│ ✓ Challenge signed
│ ✓ Chained at sequence #1042
│
│ Agent ID: ag_7Xk9mP2qR8nK4...
│ Status:   pending
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
```

**Specs:**
- Background: `--bg-tertiary`
- Border: none (rely on bg contrast against `--bg-primary`)
- Border-radius: 8px
- Padding: 20px
- Font: `--font-mono`, 14px, 400 weight
- Text: `--text-secondary` default
- Copy button: top-right, icon only (`⧉`), `--text-tertiary`, shows "Copied" tooltip on click
- Max height: 400px, scrollable

**Syntax highlighting (minimal):**
- Commands/keywords: `--text-primary`
- Strings: `--accent`
- Comments: `--text-tertiary`
- Success markers (✓): `--status-active`
- Error markers (✗): `--status-suspended`
- Hash values: `--hash`

**Variants:**
- **Terminal:** Has `$` prompt prefix. Slightly different padding-left for alignment.
- **Code:** Language label top-left (e.g., `typescript`), same `--text-tertiary`.
- **Inline code:** `--bg-tertiary` bg, `--font-mono`, 13px, 2px 6px padding, 3px radius. Used in body text.

---

## Verification Row

Used in agent profile verification history.

```
✓ pass   by ag_9Qm4...   coherence: 0.90   2h ago
```

**Specs:**
- Result icon: `✓` green or `✗` red, 14px
- Result text: "pass" or "fail", same color as icon, mono
- Verifier: agent ID, mono, `--text-tertiary`, linked to profile
- Coherence: "coherence: 0.XX", mono, `--text-secondary`
- Timestamp: relative time, `--text-tertiary`, right-aligned
- Row: no explicit container, bottom 1px `--border` separator
- Hover: bg → `rgba(255,255,255,0.02)`

---

## General Component Rules

**Spacing:** 4px base unit. Common spacings: 8, 12, 16, 20, 24, 32, 48.

**Transitions:** 150ms ease for hover states (color, bg, transform). No transitions on page load.

**Focus states:** 2px `--accent` outline, 2px offset. All interactive elements must be keyboard-accessible.

**Loading states:** Skeleton screens (pulsing `--bg-tertiary` → `--bg-secondary`), not spinners. Match the component's exact shape.

**Empty states:** Centered text, `--text-tertiary`. E.g., "No agents match your filters." with a [Clear filters] link.

**Responsive breakpoints:**
- `≥1200px`: Full layout (3-col grid, sidebar)
- `768–1199px`: 2-col grid, sidebar collapses
- `<768px`: Single column, hamburger nav, stacked layout
