# Codebase notes — what's already done & what to change

> Read before opening any PR. This file maps the design system in this folder to the **actual files** in `/Users/bytedance/projects/helm`, calls out what's already in place from prior design passes (P0/P1/P2 + Phase 79), and gives the implementer the smallest possible diff for each change.

## What I actually read

| File | Verdict |
|---|---|
| `web/src/styles/app.css` (677 lines) | The single source of truth for tokens. All my proposed tokens match its names exactly — see `colors_and_type.css` in this folder. |
| `web/src/components/Layout.tsx` | The `Chats` nav group is **already** in the sidebar (lifted from flat-list in Phase 79 follow-up). The `KNOWLEDGE` group is not — that's still ahead of us. |
| `web/src/App.tsx` | Routes today: `/approvals /chats /bindings /campaigns /cycles/:id /tasks/:id /roles /requirements /harness /settings`. `/subscriptions` and `/plugins` do not exist. |
| `web/src/pages/Approvals.tsx` (211 lines) | Already uses `.danger-outline` for Deny (P0-5 shipped). Already has the Phase 46d "Remember as policy rule" toggle. The shape is good — the missing pieces are stat strip, card variant for `.tone-warn`, and toast for action errors. |
| `web/src/pages/Chats.tsx` (802 lines) | Already uses `helm-rail-layout` (Phase 79). 2 `window.confirm()` sites. 5+ `title=` tooltips. Inline modal for Mirror-to-Lark. |
| `web/src/pages/Roles.tsx` (1060 lines) | Hand-rolled tabs. 1 `window.confirm()`. 5+ `title=` tooltips. **Biggest payoff page** — rail+content+inspector would change it most. |
| `web/src/pages/Settings.tsx` (~770 lines, brief says 876 incl. comments) | Contains Subscriptions + Plugins inline. 1 `window.confirm()`. Section affordances (h3 + card) already present from P1-3. |
| `web/src/pages/Bindings.tsx` (319 lines) | 1 `window.confirm()`. Already uses sectioned (Pending / Active) flat list. |
| `web/src/components/EmptyState.tsx` | Exists. Used in 8+ places (better than the brief's "only used in 2 places"). Don't replace — extend. |
| `docs/design/2026-05-06-polish-pass.md` | P0-1..6 done. P1-1..9 done. P2-1..5 mostly done. |
| `docs/design/2026-05-06-a11y-audit.md` | A1..A8 done. A7 deferred by design (Approval confirm dialog kills speed). |
| `docs/design/2026-05-17-design-brief.md` | The brief I was handed = this file, verbatim. |

## What's already in place — don't re-do

- **Token block** (`@theme inline` + `:root` + dark-mode override). `colors_and_type.css` matches it exactly. PR 1 from my old plan is **already shipped**.
- **`:focus-visible` ring** (P0-1, A4). All interactive elements covered.
- **Input / select / textarea reset** (P0-2). Don't touch in shadcn migration.
- **Ghost + danger-outline button classes** (P0-4, P0-5). `Button` primitive should preserve these as variants `ghost` and `danger-outline`.
- **Halo on status dots** (P2-3, A3). Keep.
- **Sidebar footer with pulse on `err`** (P1-4). Keep.
- **`.helm-rail-layout`** (Phase 79). The 2-col rail+detail pattern lives in CSS already. The redesign extends to a 3rd inspector column for Active Chats only — new `.helm-rail-layout--with-inspector` modifier.
- **Sidebar `Chats` nav group** (Phase 79 follow-up). The grouped-nav primitive in `Layout.tsx` (`NavGroup` / `isGroup()` discriminator) is in place. Adding `KNOWLEDGE` is a 4-line patch — see PR plan.
- **Reduced-motion**: every animation in `app.css` is already gated by `@media (prefers-reduced-motion: no-preference)`. Keep this gate when adding new animations.

## What's NOT in place — design-system additions

Only these tokens are NEW (and need merging into `app.css`'s `:root` + dark block + `@theme inline`):

```
/* Type scale (5 sizes, today helm has 2) */
--text-display / --text-h1 / --text-h2 / --text-h3 / --text-body / --text-caption / --text-mono
--leading-* (paired)

/* Semantic tints (today helm has none) */
--surface-accent-tinted / --surface-danger-tinted / --surface-warn-tinted / --surface-success-tinted
--border-accent-tinted / --border-danger-tinted / --border-warn-tinted / --border-success-tinted

/* Popover / modal shadow tier (today helm has only sm + card) */
--shadow-popover / --shadow-modal

/* Spacing tokens (today helm uses ad-hoc px) */
--space-1..12

/* Motion tokens (today helm hard-codes 80ms ease in transitions) */
--motion-instant / --motion-fast / --motion-normal
--ease-standard / --ease-emphasis

/* Layout (rail/inspector widths — derived from existing 240px in CSS) */
--rail-width / --inspector-width
```

Everything else in `colors_and_type.css` is a copy of what's already in `app.css`. The implementer can review the diff in 30 seconds.

## Concrete file-by-file change list

### `web/src/styles/app.css`
- **Merge** new tokens above into the `:root` block and dark-mode block.
- **Extend** the `@theme inline` block to expose new tokens to Tailwind utilities (e.g. `bg-surface-warn-tinted`, `text-display`).
- **Add** card variants: `.helm-card--warn`, `.helm-card--danger`, `.helm-card--success`, `.helm-card--interactive`, `.helm-card--selected`. Each one is ≤4 lines.
- **Add** `.helm-rail-layout--with-inspector` modifier (1 extra grid column).
- No rename of existing classes. No edit of existing rules unless explicitly listed in a PR.

### `web/src/components/Layout.tsx`
- Add `KNOWLEDGE` `NavGroup` between `Chats` and the flat `Roles` entry.
- Move `Roles` into the group; add `Subscriptions` and `Plugins` items.
- Replace text labels with `<lucide.Icon size={16}/>` + label spans on every nav row.
- Brand row swaps inline `<h1>Helm</h1>` for `<HelmGlyph/>` + `<span>helm</span>` (lowercase per content rules — but **confirm this with user**; today's UI says `Helm` capitalized).

### `web/src/App.tsx`
- Add `<Route path="/subscriptions" element={<SubscriptionsPage/>}/>`.
- Add `<Route path="/plugins" element={<PluginsPage/>}/>`.
- Lift `<SubscriptionsSection/>` and `<PluginsSection/>` out of `Settings.tsx` into `pages/Subscriptions.tsx` and `pages/Plugins.tsx`. Same data flow; the components just move file.

### `web/src/components/` — new primitives
Add these (themed via existing CSS vars; no new deps for the local ones; shadcn/Radix for the rest):

| File | What | Replaces |
|---|---|---|
| `Button.tsx` | `<Button variant="primary|default|ghost|danger|danger-outline" size="sm|default" icon={Icon}>` | All ad-hoc `<button>` JSX (~40 sites) |
| `Badge.tsx` | tone variants + optional leading dot | All inline status pills in Chats / Roles / Bindings |
| `Card.tsx` | variants: `default|interactive|selected|warn|danger|success` | `<article className="helm-card">` (~30 sites) |
| `IconButton.tsx` | wraps `<Button>` with Radix `<Tooltip>` | All `title="…"` icon buttons (~12 sites) |
| `Tabs.tsx` | shadcn `tabs.tsx` themed | Hand-rolled tabs in `Roles.tsx` |
| `Dialog.tsx` | shadcn `dialog.tsx` themed | 4 `window.confirm()` sites |
| `Tooltip.tsx` | Radix; 200ms delay | All remaining `title="…"` tooltips (~18 sites total per brief) |
| `Combobox.tsx` | shadcn `command.tsx` (cmdk) | "+ Add role" `<select>` in Chats |
| `Select.tsx` | shadcn `select.tsx` themed | Remaining 6 `<select>` sites |
| `Toaster.tsx` | `sonner` mounted at root | Inline red `<p>` errors |
| `Skeleton.tsx` | local | `<p className="muted">Loading…</p>` |
| `PageHeader.tsx` | title + subtitle + stats + actions | The repeated h2 + muted-p pattern on every page |
| `StatTile.tsx` | numeric tile for `PageHeader stats` | One instance today on Chats (Phase 79) |

### Deps to add to `web/package.json`
```
lucide-react           ^0.460
@radix-ui/react-dialog ^1.1
@radix-ui/react-tooltip ^1.1
@radix-ui/react-tabs   ^1.1
@radix-ui/react-select ^2.1
@radix-ui/react-dropdown-menu ^2.1
cmdk                   ^1.0
sonner                 ^1.7
clsx                   ^2.1
tailwind-merge         ^2.5
class-variance-authority ^0.7
```

No new dev deps. Total bundle add ≈ 80 kB gzipped — fine for an Electron app.

## What I did NOT change

- **Backend / data model / MCP surface** — out of scope per brief §9.
- **Routes** — only added 2 new (`/subscriptions`, `/plugins`). `/campaigns` and `/requirements` stay routable but hidden, per brief §4.
- **Feature inventory** — every helm feature still exists in the redesign.
- **`helm-rail-layout` CSS** — extended, not rewritten.
- **Brand capitalization** — codebase + user-locked decision: `Helm` (cap H). Don't change.

## Decisions locked (2026-05-17)

All resolved by user on first-pass review:

- **Brand mark.** Always `Helm` (cap H). Codebase already says this; my earlier docs incorrectly lowercased it. Fixed.
- **Brand glyph.** Helm has **no logo yet** — the sidebar brand row is just the wordmark `Helm` at 14 px / 600 weight. The placeholder ship's-wheel SVG has been removed from the sidebar; it survives only as a 64 px empty-state mascot in `preview/component-empty-state.html`, where it reads as a generic icon rather than a brand claim. If a real logo arrives, replace `assets/logo.svg` and add the `<img>` next to the wordmark in `Layout.tsx`.
- **Group label.** `Knowledge` in source; uppercase rendering via existing `.helm-nav-group-label` CSS, mirroring the existing `Chats` group.
- **e2e tests.** Updating Subscriptions / Plugins e2e in PR 5 is allowed; this unblocks lifting them out of Settings.
- **Roles page real shape.** Captured from screenshot 2026-05-17. The proposed redesign in the UI kit is updated to match: flat list of cards, each with `BUILT-IN/CUSTOM · ROLE-ID` caps-mono label, title, 2-line description clamp, dot + chunk count, Show / Update via chat buttons; inline expansion reveals Chunks / Sources / Candidates / Archive tabs.
