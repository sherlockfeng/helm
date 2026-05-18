# helm — Design recommendations & handoff plan

> This document is the implementer-facing companion to `README.md`. It tells the helm dev agent **exactly what to change in the existing codebase**, in PR-sized chunks, grounded in what's already shipped (Phase 79 + the May-06 polish-pass + a11y-audit).
>
> Read [`CODEBASE-NOTES.md`](./CODEBASE-NOTES.md) first — it maps every design proposal to the file it touches.

---

## What's already shipped (don't re-do)

`docs/design/2026-05-06-polish-pass.md` (P0/P1/P2) and `2026-05-06-a11y-audit.md` (A1–A8) are mostly merged. Phase 79 added Tailwind v4 + the `Chats` nav group + the `helm-rail-layout` 2-col pattern on Active Chats. Specifically:

- `:focus-visible` ring, input/select/textarea reset, ghost + danger-outline button classes, halo status dots, sidebar footer with pulse-on-error, dark-mode contrast bump — **done.**
- Token block (`@theme inline` + dark `:root`) — **done.** All my proposed token names match exactly.
- `<EmptyState/>` component — **exists** (`web/src/components/EmptyState.tsx`); use everywhere.
- `Chats` nav group with `Active / Bindings / Approvals` — **done** in `Layout.tsx`.
- `helm-rail-layout` on Active Chats — **done.** Other pages can opt in.

That cuts the original 12-PR plan to **9 PRs** below.

---

## 1. Final sidebar IA

```
helm                                         ← brand row (glyph + lowercase wordmark*)
├─ CHATS                                     ← group (already in Layout.tsx)
│   ├─ Active           /chats               MessagesSquare    · count badge
│   ├─ Bindings         /bindings            Link2             · count badge
│   └─ Approvals        /approvals           ShieldCheck       · count badge (warn if expiring)
├─ KNOWLEDGE                                 ← NEW group (label rendered uppercase via CSS, source: "Knowledge")
│   ├─ Roles            /roles               BookOpen          · count badge (accent if candidates>0)
│   ├─ Subscriptions    /subscriptions       Cloud             ← lifted from Settings
│   └─ Plugins          /plugins             Plug              ← lifted from Settings
├─ Harness              /harness             Workflow          · count badge
└─ Settings             /settings            Settings          ← pinned via flex spacer
```

\* Brand mark: codebase says **Helm** today (cap H). Locked. No logo yet — just the wordmark. If a logo file arrives, drop it next to the wordmark in `Layout.tsx`.

Routes kept for back-compat but hidden from nav: `/campaigns`, `/requirements` (already hidden per `Layout.tsx` comment).

---

## 2. Page-layout templates

5 templates. Every page should be one of them.

### T1 · Single-action page  *(Approvals, Bindings)*
`PageHeader (title + sub + stats + actions)` → body, `max-width: 720px` (existing `--container-max`), single column of cards.

### T2 · Workspace 2-col  *(Roles, Harness when binding chats)*
`PageHeader` → `<div class="helm-rail-layout">` (existing) → `.helm-rail` + `.helm-rail-content`.

### T3 · Workspace 3-col  *(Active Chats)*
NEW modifier `.helm-rail-layout--with-inspector` → rail + content + inspector. Implemented as a 3rd grid column.

### T4 · Setting page  *(Settings — already structured this way after P1-3)*
`PageHeader (title + Save action)` → 2-col `rail` (section list) + content (≤640w form cards). Today Settings is single-column. Adding a rail is a 1-component change.

### T5 · Wizard / modal flow  *(Bind to chat, Train role)*
Center-screen Radix `<Dialog>`. 420w default, 640w for forms. Esc to close, focus trap automatic.

---

## 3. Component primitive commitments

| Primitive | Source | Replaces in helm | Files touched |
|---|---|---|---|
| `Button` | local `cva` + existing `.btn` rules | All ad-hoc `<button>` JSX | ~40 sites across pages |
| `Badge` | local `cva` | Inline status pills | Chats, Roles, Bindings |
| `Card` | local with `variant` prop | `<article className="helm-card">` (~30 sites) | All pages |
| `IconButton` | local; wraps `Button` + Radix `Tooltip` | Icon-only buttons with `title=` | Roles, Chats, Settings |
| `Tabs` | shadcn `tabs.tsx` themed | Hand-rolled tabs in `Roles.tsx` (lines ~520) | Roles |
| `Dialog` | shadcn `dialog.tsx` (Radix) | 4 `window.confirm()` sites | Roles:169, Settings:770, Bindings:100, Chats:148 |
| `Tooltip` | shadcn `tooltip.tsx` (Radix), 200 ms delay | Remaining `title="…"` tooltips (~18 sites) | Approvals, Chats, Roles, Bindings, Harness, Settings |
| `Combobox` | shadcn `command.tsx` (cmdk) | "+ Add role" `<select>` | Chats |
| `Select` | shadcn `select.tsx` (Radix) themed | Remaining 6 `<select>` sites | Settings (Cursor model, kind selectors) |
| `Toaster` | `sonner` mounted at root | Inline red `<p>` API-error renders | App.tsx + every page's error path |
| `Skeleton` | local | `<p className="muted">Loading…</p>` (8+ sites) | Approvals, Chats, Roles, Bindings, Harness, Settings |
| `PageHeader` | local: title + subtitle + stats + actions | Repeated h2 + muted-p pattern | Every page |
| `StatTile` | local; used inside PageHeader | The Phase 79 inline stat strip on Chats | Generalized to all pages |

`cn = clsx + tailwind-merge`, `cva = class-variance-authority` — install as deps.

---

## 4. Typography + spacing (recap)

5 sizes (see `colors_and_type.css`): display 28/32 · h1 22/28 · h2 17/22 · h3 13/16 caps · body 13/18 · caption 11/14 · mono 12/16. Today helm has only h2 (22) + body (13) + h3-caps (13).

Spacing tokens (NEW): `--space-1..12` on a 4 px grid. Today helm uses ad-hoc px in inline `style={{}}`. The brief flags **302 occurrences** of inline `style` — most are paddings + gaps. Migrating to spacing tokens is a long-tail cleanup, not a PR.

---

## 5. Color usage map

| Token | Allowed surfaces |
|---|---|
| `--accent` | Primary buttons, selected nav rows, focus rings, links, "bound" / "in use" badges. |
| `--success` | Status dots (synced, bound), success toast, success card accent bar. Never as a button background. |
| `--warn` | Expiring approvals (TTL < 30 s), pending Lark bindings, decay-candidate badges. Card accent bar on cards needing attention. |
| `--danger` | Deny buttons, destructive secondary actions, "danger zone" card variant, danger toast. Never on a primary action. |
| Tinted surfaces | Card-row background **only** when paired with a 3 px left accent bar. No full-bleed tone surfaces. |

Two surface colors + one semantic tone per screen, max.

---

## 6. State pattern set

| State | Pattern |
|---|---|
| Loading (first paint) | `<Skeleton/>` matching the card shape. 1.4 s shimmer. Respects `prefers-reduced-motion`. |
| Loading (refresh) | Don't blank out content. Optional 1 px accent progress bar at top of PageHeader. |
| Empty | Existing `<EmptyState>` (extend with optional 64 px glyph + 0–2 actions; keep API back-compat). |
| Error (page-level) | `<Card variant="danger">` with title, body, retry action. |
| Error (action-level) | Toast (danger tone) at bottom-right, 4 s, with the underlying error string in mono. |
| Success | Toast (success tone), 3.2 s. |
| Async pending button | Leading 14 px spinner, label switches to past-progressive ("Saving…"). Disabled. `aria-busy={true}` (a11y A8 pattern). |
| Confirm destructive | `<Dialog>`. Title is a question. Body explains the side effect. Primary action is `variant="danger"`. |

---

## 7. Motion principles

3 durations × 2 easings. All driven by tokens. All gated by `prefers-reduced-motion: no-preference` — codebase already follows this pattern (`app.css:266`), keep it.

| Token | Duration | Easing | Used for |
|---|---|---|---|
| `--motion-instant` | 80 ms | standard | hover color, button press (`translateY(0.5px)` today; redesign uses `scale(0.98)`) |
| `--motion-fast` | 160 ms | standard | tabs, dropdowns, popovers, toast slide, scrim fade |
| `--motion-normal` | 240 ms | emphasis | modal in/out, sheet in/out |

What animates: toast slide-up, modal scale-in, card hover (border only), skeleton shimmer.
What doesn't: page transitions, list reorder, sidebar nav.

---

## 8. Migration plan — PR sequence

Reality-grounded sequence below. Each PR is independently revertible.

### PR 1 · Token + scale extension *(no UI change by default)*
- Merge new tokens from `colors_and_type.css` into `web/src/styles/app.css` `:root` + dark block + `@theme inline`:
  - Type scale (`--text-display..mono`, `--leading-*`)
  - Semantic tints (`--surface-{tone}-tinted`, `--border-{tone}-tinted`)
  - Popover/modal shadow tier (`--shadow-popover`, `--shadow-modal`)
  - Spacing tokens (`--space-1..12`)
  - Motion tokens (`--motion-instant/fast/normal`, `--ease-standard/emphasis`)
  - Layout (`--rail-width: 240px`, `--inspector-width: 320px`)
- Add `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react` to deps.
- **Acceptance:** zero visual diff; new tokens resolvable in DevTools.

### PR 2 · `Button` + `Badge` + `IconButton` primitives
- New `web/src/components/Button.tsx` with variants `primary | default | ghost | danger | danger-outline` and sizes `sm | default`. Wraps the existing `.btn` class rules — purely an API change.
- `Badge.tsx` with tone variants + optional leading dot.
- `IconButton.tsx` wraps `Button` + Radix Tooltip (200 ms delay).
- Codemod: replace `<button className="primary">` → `<Button variant="primary">` site-wide. Keep DOM identical.
- Add `@radix-ui/react-tooltip` dep.
- **Acceptance:** zero screenshot diffs.

### PR 3 · `Dialog` primitive — kill `window.confirm()`
- Add `@radix-ui/react-dialog`. New `Dialog.tsx`.
- Replace all 4 sites:
  - `Roles.tsx:169` (Drop source confirm)
  - `Settings.tsx:770` (Delete subscription)
  - `Bindings.tsx:100` (Cancel pending bind code)
  - `Chats.tsx:148` (Close + Delete chat)
- Each becomes a `<Dialog>` with title-as-question + body-with-stake + primary `variant="danger"`.
- Replace the inline modal in `Chats.tsx` (Mirror-to-Lark, line ~358) with `<Dialog>`. Replace Roles' inline modal (~735, the CREATE_GREETING form) with `<Dialog>`.
- **Acceptance:** zero `window.confirm` matches in `web/src/`. Focus trap works. Esc closes.

### PR 4 · lucide icons + sidebar IA
- New `Icons.tsx` re-exporting the lucide-react icons used in the canonical mapping (see `ICONOGRAPHY.md`).
- Update `Layout.tsx`:
  - Add `KNOWLEDGE` `NavGroup` between `Chats` and `Harness`.
  - Move existing `Roles` row into it; add `Subscriptions` and `Plugins` items.
  - Replace plain text labels with `<Icon size={16}/>` + label spans on every row.
  - Brand row: swap `<h1>Helm</h1>` for `<HelmBrand/>` (just text — no glyph) so the structure can grow if a real logo arrives later. Casing stays **Helm** (cap H, locked).
- Update `App.tsx`: add `<Route path="/subscriptions"/>` and `<Route path="/plugins"/>` pointing at new page modules.
- **Acceptance:** sidebar renders the new tree; new routes work; existing route URLs unchanged.

### PR 5 · Lift Subscriptions + Plugins out of Settings
- Move the existing `<SubscriptionsSection/>` JSX from `Settings.tsx` (the `<h3>Role subscriptions</h3>` block, around line 525, including the `window.confirm` at line 770) into `pages/Subscriptions.tsx`.
- Move `<StoragePluginsSection/>` (the `<h3>Storage plugins</h3>` block, around line 522) into `pages/Plugins.tsx`.
- Both pages use template T1 (single-action page) with the new `<PageHeader>` (from PR 6) — until PR 6 ships, render bare `<h2>` so the routes work.
- `Settings.tsx` shrinks by ~200 lines.
- Add a "moved" breadcrumb card in `Settings.tsx` body header: *"Subscriptions and Plugins moved → Knowledge."* The UI kit's Settings page (`pages/SettingsPage.jsx` in this folder, section `moved`) shows what this looks like.

**e2e impact** (required to make this PR pass):
- `tests/e2e/settings.spec.ts` — any test that opens Settings and clicks a `<h3>Role subscriptions</h3>` or `<h3>Storage plugins</h3>` heading. Re-target at `page.goto('/subscriptions')` / `page.goto('/plugins')`.
- `tests/e2e/subscriptions.spec.ts` (likely new file) — split out the existing assertions about subscription list rendering / delete flow so they run against the new route.
- `tests/e2e/plugins.spec.ts` (likely new file) — same treatment for plugins.
- Add a single regression test: `tests/e2e/settings.spec.ts` should assert the "moved" breadcrumb cards exist when the user lands on `/settings`, with click-through to `/subscriptions` and `/plugins` (catches the case where someone has a bookmark to the old anchor).
- Keep the existing `window.confirm` e2e expectations only for the **non-migrated** confirms (4 sites in PR 3; the 5th was the subscription-delete which moves with this PR).
- **Acceptance:** Settings is ~600 LOC; `/subscriptions` and `/plugins` render the same data they did inside Settings; both new e2e files pass; existing settings.spec.ts passes against the moved-out structure.

### PR 6 · `PageHeader` + `StatTile`
- New `PageHeader.tsx` accepting `title`, `subtitle`, `stats={ tiles }`, `actions`. Renders the stat strip below the title row when `stats` is provided.
- `StatTile.tsx` standalone primitive (the existing `.helm-rail-stat` CSS is the reference; rename to `.helm-stat-tile` or keep — implementer's call).
- Apply to every page. Active Chats already has a stat strip — port it to the primitive.
- **Acceptance:** every page has a consistent header. Active Chats stat strip is unchanged visually.

### PR 7 · `Card` variants
- New `Card.tsx` with `variant: default | interactive | selected | warn | danger | success`.
- CSS for variants is 5 short rules in `app.css` (3 px left accent bar + tinted background gradient → solid).
- Codemod: `<article className="helm-card">` → `<Card>`. Tag destructive Settings sections as `variant="danger"`. Tag expiring Approvals (TTL < 30 s) as `variant="warn"`.
- **Acceptance:** no raw `helm-card` JSX left; Approvals page warn-bar appears on expiring cards.

### PR 8 · `Tabs` (Roles) + `Combobox` ("+ Add role") + `Select` (rest)
- Add `@radix-ui/react-tabs`, `@radix-ui/react-select`, `cmdk`.
- Replace hand-rolled tabs in `Roles.tsx` with `<Tabs>`. Style as segmented control (active = elevated white pill).
- Replace the "+ Add role" `<select>` in `Chats.tsx` (~line 600) with a searchable `<Combobox>`. The roles list can be ~50 items for power users — search matters.
- Replace remaining 6 `<select>` sites with themed `<Select>`.
- **Acceptance:** keyboard arrow nav on tabs; combobox is searchable; Cursor-model select dark mode renders identically.

### PR 9 · Toasts + Skeletons + workspace inspector
- Add `sonner`. Mount `<Toaster/>` in `App.tsx`.
- Codemod every inline `<p className="muted" style={{color:'var(--danger)'}}>` → `toast.error(message)`. Action-success paths get `toast.success(message)`.
- New `Skeleton.tsx`. Replace `<p className="muted">Loading…</p>` (8+ sites) with skeleton blocks matching each page's card shape.
- New `.helm-rail-layout--with-inspector` CSS modifier (1 extra grid column at `--inspector-width`). Wire `ChatsPage.tsx` to use it — move the "knowledge in this chat" + "recent approvals" rendered inside the detail pane into a sidebar `<aside class="helm-inspector">`.
- **Acceptance:** API failures pop bottom-right; first paint shows skeletons; Active Chats has inspector column.

**Total: 9 PRs.** Phase 79 + polish-pass took out the foundational 3 from my original plan.

---

## 9. Visual-regression risk callouts

3 to watch (visual regressions caught by hand — no Percy / Chromatic):

1. **PR 4 IA shift.** Existing URLs to `/settings#subscriptions` keep working (the route is unchanged, but the section is no longer in Settings). The Settings breadcrumb in PR 5 handles user education. **Sanity-check the e2e test that opens Settings → Subscriptions.**

2. **PR 7 card padding.** Today `.helm-card` is `padding: 16px`. New variants don't change padding, but the `<Card>` primitive may need a `compact` size for the dense Active Chats card. Tag with `data-comment-anchor` if you want me to revisit.

3. **PR 8 combobox interaction model.** Today the "+ Add role" `<select>` accepts both click + keyboard arrows; the new `<Combobox>` is a popover with `cmdk` semantics — slightly different keyboard interaction. **Sanity-check the e2e in `tests/e2e/chats.spec.ts` that exercises +Add role.**

---

## 10. How to hand this off to your helm dev agent

This whole project is structured to drop into Claude Code as a skill.

1. **Download this project** (Export in the sidebar — or it's already a folder if local).
2. **Drop the folder** into your helm repo at `.claude/skills/helm-design/`. Claude Code auto-discovers `SKILL.md`.
3. **Open a Claude Code session in `helm/`** and paste:

> Use the **helm-design** skill. Read `CODEBASE-NOTES.md` and `HANDOFF.md` end-to-end, then read `web/src/styles/app.css` and `web/src/components/Layout.tsx` so you know what's already in place. Open PR 1 from `HANDOFF.md` §8 — merge the new token blocks into `app.css`, add `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react` to `web/package.json`. Don't change any visible UI yet. Run typecheck + tests, push the PR, stop. Wait for review before PR 2.

Repeat with `"Open PR 2…"` through `"Open PR 9…"` as you merge each. The acceptance criterion in each PR section tells the agent when to stop.

If you'd rather have one big PR:

> Read `CODEBASE-NOTES.md`, `HANDOFF.md`, and `ui_kits/helm-app/`. Migrate the entire web app to match. Single PR. Stop when typecheck + tests pass.

The UI kit gives the agent a visual target; this doc gives it the rules.

---

## 11. Decisions locked (2026-05-17)

Resolved by user on review of the first pass:

- **Brand mark.** `Helm` (cap H). The sidebar row renders just the wordmark; **no glyph**.
- **Group label.** `Knowledge` in source (rendered uppercase via CSS, matching the existing `Chats` group).
- **e2e tests.** Can be updated as part of this work. PR 5 (lift Subscriptions/Plugins out of Settings) is unblocked.
- **Roles page shape.** Confirmed via screenshot. Flat list of role cards (T1, not workspace-rail+content). Each card: `BUILT-IN/CUSTOM · ROLE-ID` caps-mono label, title, 2-line description clamp, status dot + chunk count, Show button (+ Update via chat for custom roles with chunks). Inline expand reveals the Chunks/Sources/Candidates/Archive tabs.
- **Stat strips on Subscriptions / Plugins / Bindings.** Not blocking — designer's call. UI kit ships them everywhere; remove per page if you want them flat.
