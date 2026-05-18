# helm — Design System

> The cockpit for your AI coding agents.

**Helm** is a **macOS desktop control panel** (Electron) that sits between AI coding agents (Cursor, Claude Code) and the developer. It owns a local SQLite DB, runs an HTTP + MCP surface, and gives the user one place to:

1. Auto-inject **role knowledge** into agent chats (trained from markdown).
2. **Approve risky agent actions** before they run (Allow / Deny queue).
3. **Mirror chats to Lark** (Bytedance IM) for remote review.
4. Drive a lightweight **Harness** task workflow (`new_feature → implement → archived`).
5. **Subscribe** to remote role bundles via plugin-mounted object storage.
6. Own the **config** (`~/.helm/config.json`) — engines, Lark, plugins, thresholds.

**Audience.** Solo developers on a personal Mac. Not a team product. Not CLI-first (its sibling AKM/AgentManager is the CLI-first cousin); helm is the **GUI-first** counterpart.

**Mental model.** "Helm is the cockpit for my AI agents — I can see what they're doing, what they know, and what they're asking permission to do."

---

## Sources used

This design system was built against the **real helm codebase** + design history:

- **Codebase:** `/Users/bytedance/projects/helm` (the helm repo, attached locally). Key files read:
  - `web/src/styles/app.css` (677 lines) — the canonical token + chrome CSS. `colors_and_type.css` in this folder mirrors it exactly and extends.
  - `web/src/components/Layout.tsx` — sidebar shell with the `Chats` nav group already in place (Phase 79 follow-up).
  - `web/src/pages/*` — Approvals, Chats, Roles, Bindings, Harness, Settings, Subscriptions sections, Plugins sections.
  - `web/src/components/EmptyState.tsx`, `CopyButton.tsx` — existing primitives.
- **Design history:**
  - `docs/design/2026-05-17-design-brief.md` — the original brief (`README.md`/`HANDOFF.md` in this folder are responses to it).
  - `docs/design/2026-05-06-polish-pass.md` — P0/P1/P2 items, mostly merged.
  - `docs/design/2026-05-06-a11y-audit.md` — A1–A8 items, mostly merged.
- **No Figma** — there isn't one yet.

See [`CODEBASE-NOTES.md`](./CODEBASE-NOTES.md) for the file-by-file map from each design proposal to the source line it touches.

Reference targets called out in the brief (not copied, but informing the visual direction):

- **AKM / AgentManager** (Bytedance internal sibling project, `code.byted.org/tiktok/AgentManager`) — 3-col WorkspaceShell, stat tiles, color-coded rail rows, Radix + shadcn + lucide.
- **Linear** — density, motion, tone-coded badges, command palette.
- **macOS System Settings** (redesigned) — icon-grouped sidebar nav.
- **Apple HIG** — restrained color, subtle elevation, type rhythm.

---

## Tech constraints (locked by brief)

- React 19, react-router-dom 7, Vite 6, TypeScript strict
- Tailwind v4 with `@theme inline` (preflight intentionally **off** — helm has its own resets)
- SF Pro font stack; `prefers-color-scheme: dark` works in both modes
- `-webkit-app-region: drag` on sidebar so the OS title bar follows
- Electron desktop only; min viewport ~1100×700
- No state library, no design framework (shadcn primitives are welcome additions)

---

## Index

```
README.md                       ← you are here — brand, content, visual foundations
HANDOFF.md                      ← implementer spec: IA, templates, primitives, PR plan
CODEBASE-NOTES.md               ← per-file map of proposals → real helm source lines
SKILL.md                        ← agent-invocable skill manifest (drop into Claude Code)
ICONOGRAPHY.md                  ← icon system, lucide mapping, usage rules
colors_and_type.css             ← CSS variables: surfaces, fg, semantic, type, motion
assets/
  logo.svg                      ← helm wordmark + glyph
  glyph.svg                     ← helm wheel mark (1.5 px stroke, monochrome)
preview/                        ← Design System tab cards (registered assets)
  type-*.html, color-*.html, spacing-*.html, component-*.html, brand-*.html
ui_kits/
  helm-app/                     ← the desktop app, interactive recreation
    index.html                  ← interactive walkthrough (open this!)
    README.md                   ← what's in scope + diff vs. today
    app.css                     ← layout shell + chrome (ports tokens)
    components/                 ← Sidebar, Icons, Primitives
    pages/                      ← ApprovalsPage, ActiveChatsPage, RolesPage,
                                   BindingsPage, SubscriptionsPage,
                                   PluginsPage, HarnessPage, SettingsPage
```

**Start here:**

- Designer wanting to see the visual proposal? Open `ui_kits/helm-app/index.html`.
- Implementer ready to ship? Open `HANDOFF.md`.
- Agent invoking the skill in Claude Code? Read `SKILL.md`, then `HANDOFF.md`.

---

## CONTENT FUNDAMENTALS

helm's voice is **calm, precise, and Apple-adjacent**. It's a system app, not a marketing surface. Copy carries the weight of a power-user tool used daily, so it has to read as if it respects the user's attention.

### Voice rules

| Rule | Do | Don't |
|---|---|---|
| **Address** | Implicit second person; usually drop "you". | "Hey there!" / "Welcome back!" |
| **Casing** | Title Case for nav, page H1, primary buttons. Sentence case for body, descriptions, helper text. | ALL-CAPS shouting; Random Title Case In Sentences. |
| **Tense** | Present, active. "helm injects role knowledge when a chat starts." | "helm will be injecting…" / "has injected…" |
| **Length** | Short. One sentence per idea. Two clauses max. | Run-on explanations. |
| **Numbers** | Numerals everywhere ("3 roles", "90 d", "12:04"). | "three roles". |
| **Emoji** | **Never.** No emoji in UI strings. | 🚀 / ✅ / ⚠️ |
| **Unicode glyphs** | Allowed sparingly as typographic affordances (· — →). | Decorative ★ ✦ ✨. |
| **Brand name** | Always **Helm** (cap H). Confirmed by user on 2026-05-17. | `helm` / `HELM`. |
| **Status verbs** | Past participle for state, gerund for action. "Archived", "Bound to thread". "Mirroring…", "Capturing…". | "It was archived." |

### Tone, in three adjectives

**Steady. Local. Honest.**

- *Steady* — never alarms. Even errors read like a diagnostic, not a warning siren.
- *Local* — every string assumes the user owns the machine and the data. No "we", no "our cloud".
- *Honest* — surface the underlying mechanic. "Spawning claude subprocess…", "SQLite write committed", "Plugin returned 404".

### Examples (use these as anchors)

| Surface | Copy |
|---|---|
| Empty Approvals page | **Nothing waiting.** Approvals appear here when an agent asks before running a tool. |
| Approvals card title | `cursor → run_shell_command` |
| Approvals card body | `git push origin main --force-with-lease` · requested 4 s ago, expires in 26 s |
| Role chunk badge | `12 chunks · 3 new` |
| Subscription row | `dr-dashboard@bundle.tos · v0.4.2 · synced 2 min ago` |
| Destructive confirm | **Drop this source?** 14 chunks were trained from `cursor-rules.md`. They'll be removed too. |
| Success toast | `Role exported · helm-goofy-v3.helmrole` |
| Settings section description | Engine helm uses to run reviews. Changes take effect on the next review run. |
| Sidebar group heading | `CHATS` (uppercase, tracked) |
| Loading | `Loading…` is fine inline; prefer a skeleton block on first paint. |

### Microcopy structure

- **Button labels are verbs.** *Allow* / *Deny* / *Bind* / *Train* / *Drop* / *Unarchive* / *Run review*.
- **Confirms are full sentences with a stake.** Not "Are you sure?" — instead, *"Drop this source? 14 chunks will be removed too."*
- **Inline help is one line.** If it needs two, it's a docs link.
- **No exclamation points.** Anywhere. The only exception is documented destructive copy where the system itself is yelling at hardware ("Disk full").

---

## VISUAL FOUNDATIONS

helm is a **macOS system app**, not a web product. The visual language leans on Apple HIG, with intentional Linear-style density and AKM-style color rhythm in the rail.

### Color

A six-stop neutral scale, four semantic tones, and **two opacity tints per semantic** (border-tint + surface-tint) so we can ship card accent bars and tinted backgrounds without inventing new hexes.

- **Surfaces.** `--bg` (canvas), `--bg-elev` (cards, dropdowns, modals), `--bg-sidebar` (rail), `--bg-input` (fields), `--bg-pre` (code).
- **Borders.** `--border` (default 1 px), `--border-strong` (1 px on selected/focused).
- **Foreground.** `--text` (primary), `--text-secondary` (timestamps, captions, helper), `--selected-text` (selected nav row).
- **Semantic.** `--accent` (system blue, primary action + links + selected nav rail accent), `--success` (state dots, success toasts), `--warn` (rate limits, expiring), `--danger` (deny, destructive, expired).
- **Tints.** `--surface-warn-tinted` `= rgba(255,149,0,0.08)`; same pattern for `accent` / `success` / `danger`. Used for card accent bars and subtle row highlights — never as full-bleed backgrounds.

Both light and dark are first-class via `prefers-color-scheme: dark`. See `colors_and_type.css`.

### Typography

SF Pro Text + SF Pro Display via the system font stack. **No webfonts**; this is an Electron app on macOS — `-apple-system` resolves to the real SF Pro.

A clean **5-size scale**:

| Token | Size / Leading | Weight | Use |
|---|---|---|---|
| `--text-display` | 28 / 32 | 600 | Empty-state titles, onboarding banners |
| `--text-h1` | 22 / 28 | 600 | Page title |
| `--text-h2` | 17 / 22 | 600 | Section title in a page |
| `--text-h3` | 13 / 16 | 600, tracked 0.08em, uppercase | Sidebar group, table column header |
| `--text-body` | 13 / 18 | 400 | All body, list rows, form labels |
| `--text-caption` | 11 / 14 | 400 | Timestamps, helper text, metadata |
| `--text-mono` | 12 / 16 | 400 | SF Mono — paths, IDs, command lines |

Numbers should be **tabular** in tables / stat tiles: `font-variant-numeric: tabular-nums`.

### Spacing

4 px base grid. **Use these tokens; no off-scale paddings.**

```
--space-1 : 4px      tight icon padding, badge inner
--space-2 : 8px      icon ↔ label, chip gap
--space-3 : 12px     button padding-y, list-row gap
--space-4 : 16px     card inner padding (compact), section gap
--space-5 : 20px     card inner padding (default)
--space-6 : 28px     page gutter, between unrelated sections
--space-8 : 40px     page top padding
```

### Radii

Mac-soft, never pill except for badges.

```
--radius-xs : 4px    badge, tag
--radius-sm : 6px    button, input, single row
--radius-md : 10px   card, dropdown, popover
--radius-lg : 14px   modal, sheet
--radius-full        rounded chips, avatar
```

### Borders

Hairlines only. helm uses borders to **separate**, not to **decorate**.

- 1 px solid `--border` on all cards, inputs, dividers.
- 1 px solid `--border-strong` on focus + active selection.
- `:focus-visible` adds a 2 px `--accent` ring with 2 px offset (Mac-native focus look).
- **Card accent bars**: 3 px left bar in `--{tone}` for "danger zone", "destructive", "needs attention" sections only. Never decorative.

### Elevation / shadows

Two tiers, plus an inset for inputs.

```
--shadow-1: 0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.03);
            cards at rest
--shadow-2: 0 8px 24px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.06);
            dropdowns, popovers, modals, toasts
--shadow-inset: inset 0 0 0 1px var(--border);
            inputs (overrides border for crispness)
```

Dark mode flattens both — shadow becomes mostly border (`--shadow-1-dark` is half-alpha).

### Backgrounds

- **No gradients.** Anywhere. Not on buttons, not on hero areas, not on cards. The only "gradient" allowed is a 1 px protection gradient at the top of a scrolling rail when content underflows the title.
- **No imagery in chrome.** App canvas is `--bg`. Cards are `--bg-elev`. That's it.
- **No textures, no patterns.** If something needs visual weight, it gets a tinted surface (`--surface-{tone}-tinted`) or a left accent bar — never a pattern.
- **Code blocks** use `--bg-pre` and SF Mono. Inline code uses the same fill at 6 px radius.

### Transparency / blur

Used only in two places:

1. **Sticky page header**, when content scrolls under it: `backdrop-filter: blur(20px) saturate(180%)` over `rgba(var(--bg-elev-rgb), 0.72)`. Mac-native vibrancy.
2. **Toast / popover layer**, dark mode only: same recipe, lighter alpha.

Modals are **solid** (`--bg-elev`) with an `rgba(0,0,0,0.35)` scrim. No vibrancy on modals — they're focused work.

### Cards

The single biggest UI debt in helm is "every card looks identical." We solve it with **variants**, not new shapes.

| Variant | Border | Accent bar | Use |
|---|---|---|---|
| `default` | `--border` | none | List rows, role cards, task cards |
| `interactive` | `--border`, hover→`--border-strong` | none | Clickable cards; cursor: pointer |
| `selected` | `--border-strong` | none, but `--selected` fill | Currently-open detail |
| `warn` | `--border` | 3 px left `--warn` | Expiring approvals, decay candidates |
| `danger` | `--border` | 3 px left `--danger` | "Danger zone" sections in Settings |
| `success` | `--border` | 3 px left `--success` | Just-completed states, banners |
| `inset` | none | none, fill `--bg` | Cards inside cards (nested config) |

Card shape is constant: `--radius-md` corners, `--shadow-1`, `--space-5` padding, 12 px gap between header / body / footer rows.

### Motion

Motion is **functional**, not decorative. Tied to a 3-rung duration scale.

| Token | Duration | Easing | Used for |
|---|---|---|---|
| `--motion-instant` | 80 ms | `cubic-bezier(0.4, 0, 0.2, 1)` | Hover color, button press |
| `--motion-fast` | 160 ms | `cubic-bezier(0.4, 0, 0.2, 1)` | Tabs, popovers, dropdowns, toast slide |
| `--motion-normal` | 240 ms | `cubic-bezier(0.32, 0.72, 0, 1)` | Modal in/out, sheet in/out, page transitions |

Rules:
- **Press** = scale `0.98` for 80 ms on primary buttons only.
- **Hover** = background color flip at 80 ms. No scale, no shadow change.
- **List reorder** = `transform` only, 160 ms. No layout thrash.
- **Page transitions** = none. Sidebar nav is instant; the user is navigating, not browsing.
- **Skeletons** shimmer at 1.4 s period, 0–100 % keyframe.
- **Respect `prefers-reduced-motion`** — durations collapse to 0.

### Hover / press / focus

- **Hover** on a row or interactive card: background → `--hover`. Border: unchanged unless `interactive`.
- **Press** on a button: scale `0.98`, brightness `0.95`. 80 ms.
- **Focus-visible** on any tabbable element: 2 px outline `--accent`, 2 px offset, 6 px radius (matches button corner + offset).
- **Disabled**: opacity 0.4, no pointer events, cursor `not-allowed`.

### Layout rules

- **Sidebar is fixed.** 220 px wide. `-webkit-app-region: drag` so the OS title bar follows.
- **Content pane** has `max-width: 720 px` on flat pages (Settings, Bindings) — readable line length matters.
- **Workspace pages** (Active Chats, Roles) use a **rail + content + (optional) inspector** layout, no max-width. Rail is 280 px, inspector is 320 px when present.
- **Page top padding** is 40 px from the title bar drag area, 28 px gutter on left + right of content (the rail edges absorb the leftmost gutter).
- **Sticky page header** when the page scrolls: title, optional stat strip, optional primary action — same row.

## Brand mark

**Helm does not have a logo today** (confirmed by user 2026-05-17). The sidebar renders just the wordmark **"Helm"** at 14 px semibold, no glyph. If a logo arrives later, drop it next to the wordmark in `Layout.tsx` and replace `assets/logo.svg`. The placeholder helm-wheel SVG that was in earlier drafts has been removed from the brand row — it remains in `preview/component-empty-state.html` only as a 64 px empty-state mascot, where it reads as a generic icon rather than a brand claim.

### Density

A two-mode system, controlled by user preference (Settings → Appearance → Density):

- **Comfortable** (default) — `--space-5` card padding, 13 px body, 32 px row height.
- **Compact** — `--space-4` card padding, 13 px body, 26 px row height. For power users with one 14" screen and 8 cards visible.

The scale doesn't change in compact — only paddings and row heights.

---

## ICONOGRAPHY

See [`ICONOGRAPHY.md`](./ICONOGRAPHY.md) for the full mapping. Short version:

- **Library:** [lucide-react](https://lucide.dev) — `lucide` is the natural pairing with shadcn / Radix and matches AKM. CDN: `https://unpkg.com/lucide-static@latest/icons/<name>.svg`.
- **Stroke weight:** 1.75 px (the lucide default for 16 px usage at our base size).
- **Default size:** 16 px in buttons, 18 px in sidebar rows, 14 px in inline metadata.
- **Color:** inherits `currentColor`. Default to `--text-secondary` in nav and metadata; `--text` in primary buttons; semantic tone where it carries meaning (red trash, green check).
- **No emoji. No PNG icons. No hand-rolled SVG except for the helm wordmark and glyph.**

---

## How to use this design system

You're an agent (or designer) building a helm screen, slide, mock, or marketing surface.

1. **Read `colors_and_type.css`.** Pull the tokens — don't re-pick colors.
2. **Open the Design System tab** in this project to flip through every primitive at a glance.
3. **Crack open `ui_kits/helm-app/index.html`** for a working layout — sidebar, rail, content, inspector, modal patterns, the lot.
4. **Pull from `assets/`** for the wordmark, glyph, and lucide icon URLs.
5. **Stay in two surface colors and one semantic tone per screen.** helm gets noisy fast if every page lights up four colors.

If you find yourself reaching for a new color, a gradient, an emoji, or a card variant not listed above — **stop and ask the user**. helm's restraint is the brand.
