# Helm UI Polish Pass — 2026-05-06

> Design subagent critique per AGENTS.md §3. This document captures findings before implementation; the Phase 20 PR applies P0 + P1 items, P2 items become future cleanup.

## Stage

Final-polish on a structurally-complete v1. Routes, data flow, SSE wiring all done; this pass is purely visual / interaction / a11y.

## Constraints

- Native macOS Electron app — system font stack, Apple HIG cues
- `prefers-color-scheme` automatic dark / light
- Zero design framework — raw CSS variables only
- No new deps; routing is fixed; we don't move pages around

---

## P0 — Must fix

P0-1 — **No focus-visible styles anywhere; keyboard users can't tell where they are**
- File: `web/src/styles/app.css` (across `button`, `.helm-nav a`, inputs)
- Currently every interactive element has `:hover` but nothing for `:focus-visible`. On macOS Electron with VoiceOver / keyboard nav, the user has zero visual feedback.
- Fix: add `:focus-visible` outline (3px ring, accent color, 2px offset) to button, `.helm-nav a`, `input`, `select`, `<a>`. Drop the default browser outline only via `:focus:not(:focus-visible)`.

P0-2 — **Inputs have no design-system styling — they inherit OS defaults inconsistently across light/dark**
- File: `web/src/styles/app.css` — no `input` / `select` / `textarea` rules at all
- Files with bare inputs: `Settings.tsx:127–134`, `:154–160`, `:181–192`, `:196–207`, `:213–224`, `:225–236`; `Bindings.tsx:83–92`
- In dark mode the OS-default white inputs glow against the dark card background. Inputs need explicit `background: var(--bg-elev); color: var(--text); border: 1px solid var(--border);`.
- Fix: add `input[type="text"], input[type="number"], input[type="password"], select, textarea` rule with consistent padding, radius, border, focus ring.

P0-3 — **Dark-mode `--selected` color clashes with text contrast on active nav item**
- File: `web/src/styles/app.css:40` — `--selected: #0a4cb1;` (a saturated blue) plus active nav text `var(--text)` (`#f5f5f7` near-white). Contrast is fine but the saturated blue + white reads as "button I should click" rather than "section I'm in", competing with the actual primary action on the page.
- Fix: dark `--selected: rgba(255, 255, 255, 0.08)` (subtle surface elevation), keep light `--selected: #d8e4ff`. Active nav item also gets `font-weight: 600` so it's distinguished without the heavy fill.

P0-4 — **All buttons share the same visual weight; no clear primary on Settings page**
- File: `web/src/pages/Settings.tsx:249–257` — the bare "+ Add mapping" button styled identically to the Save/Revert pair (`Settings.tsx:260–267`); plus mappings have an inline `Remove` button (`:237–246`) that's `.danger` and visually screams.
- Fix: introduce `.button-ghost` (transparent bg, no border, accent text) for the secondary "+ Add mapping" affordance; soften inline destructive buttons in dense lists by using `.button-text` (text-only red, no fill) so the eye lands on the page-level primary Save first. The `.danger` filled style stays for top-level destructive actions (Unbind / Deny).

P0-5 — **Approval card "Allow" + "Deny" buttons compete equally — but allow is the safe path the user takes 95% of the time**
- File: `web/src/pages/Approvals.tsx:113–120`
- Visual: filled-blue Allow + filled-red Deny same size. The red filled Deny pulls the eye more than the blue Allow despite being less common.
- Fix: keep Allow filled `.primary`. Demote Deny to `.danger.outline` (red text + red border, no fill). Same color signal, less visual aggression.

P0-6 — **`<pre>` blocks for command preview lose contrast in dark mode**
- File: `web/src/styles/app.css:183–193` — `background: var(--bg)` plus `border: 1px solid var(--border)` on a card whose background is also `var(--bg-elev)`. In dark mode `--bg` (`#1c1c1e`) and `--bg-elev` (`#2c2c2e`) are very close → the pre block barely separates from the card.
- Fix: in dark, override `.helm-card pre` background to `rgba(0, 0, 0, 0.25)` for genuine contrast against `--bg-elev`. Light mode is fine.

---

## P1 — Should fix

P1-1 — **Page header pattern repeats inline JSX — no `<PageHeader>` component, breadcrumbs are unaligned**
- Files: `CycleDetail.tsx:75–87`, `TaskDetail.tsx:38–50` — both manually compose breadcrumb + h2 + status pill row in slightly different ways. The TaskDetail version puts status on the same line as role label (cramped); CycleDetail puts it after a paragraph break.
- Fix: still no new component (constraint), but standardize the JSX shape — breadcrumb above h2 above a status row in a flex-aligned div with `gap: 12px`. Both pages mirror the pattern.

P1-2 — **Empty states all use the same dashed-box pattern but with very different messages**
- File: `web/src/styles/app.css:217–223` (`.helm-empty`)
- Messages range from "No pending approvals." (4 words) to "No active Cursor chats. Start one and Helm will pick it up automatically." (12 words). Some are commands ("Run `init_workflow`..."), some are passive ("No bindings yet."). 
- Fix: format every empty state with two lines — first line is the empty fact (1 sentence); second line is the suggested next action (smaller, muted). Update `.helm-empty` to support `<strong>` first line + `<p>` body.

P1-3 — **Settings page is a long single column without section affordances**
- File: `web/src/pages/Settings.tsx:104–283` — five `.helm-card`s plus a Diagnostics block. The user can't quickly jump to a section.
- Fix: precede each card with an `<h3>` (section title) outside the card; current "HTTP API" / "Lark integration" / "Depscope" labels are inside `.label` styling at 11px uppercase — fine for card metadata, wrong for section dividers. Move them out. Also reduce card max-width to ~640px; current full-width on a 1100px window makes the inputs feel comically wide.

P1-4 — **Sidebar status indicator at the bottom is hidden visually**
- File: `web/src/components/Layout.tsx:67–72`
- "Connected" / "Backend offline" sits in `8px 12px` padding with no visual separation from the nav above. When backend goes offline, the user has no peripheral signal — the indicator is too subtle.
- Fix: add `border-top: 1px solid var(--border); padding: 12px;` so the status block becomes a visually distinct sidebar footer. When `err`, the dot pulses (`@keyframes pulse` 1s ease-in-out infinite).

P1-5 — **Tables of code (audit log entries) cram timestamp + path + token onto one line**
- File: `web/src/pages/TaskDetail.tsx:94–106`
- Currently: `<code>HH:MM:SS</code>  <code>filePath</code>  <span class="label">token...</span>` — three monospace runs with two spaces between, no alignment, hard to scan.
- Fix: use a `display: grid; grid-template-columns: 80px 1fr 100px; gap: 8px;` per row so timestamps line up vertically.

P1-6 — **Diagnostics path shown as `<code>{bundleDir}</code>` with no copy affordance**
- File: `web/src/pages/Settings.tsx:276–280`
- The user is going to want to paste this into a bug report. A visible Copy button next to the path is one click vs cmd+click → Copy.
- Fix: add a small "Copy" button next to the code element using `navigator.clipboard.writeText`. Show a 2-second "Copied" confirmation.

P1-7 — **Diagnostics export button has no loading state**
- File: `web/src/pages/Settings.tsx:275`
- The bundle takes 1-3 seconds. User clicks, nothing happens, they click again → potentially produces two bundles.
- Fix: add submitting state mirroring Bindings page pattern, label flips to "Exporting…" while disabled.

P1-8 — **Save success banner doesn't auto-dismiss**
- File: `web/src/pages/Settings.tsx:112–116`
- A green banner stays forever after successful save until the user makes another edit. After dirty state changes, it disappears. But unmodified navigation away still leaves stale "Saved." text on next visit.
- Fix: `setTimeout(() => setSaveOk(null), 4000)` on save success.

P1-9 — **Active Chats page session id is rendered as a long opaque string**
- File: `web/src/pages/Chats.tsx:43–44`
- `session {chat.id}` shows the full UUID. Same issue in Bindings dropdown (truncated to 8 chars there which is better).
- Fix: render session id as `<code>{chat.id.slice(0, 12)}…</code>` with a `title={chat.id}` tooltip for the full value. Apply consistently.

---

## P2 — Nice to have

P2-1 — **No window-traffic-light spacer**
- File: `web/src/styles/app.css:93–100`
- macOS traffic lights overlap the `Helm` h1 in the sidebar at default position. The `-webkit-app-region: drag` makes the area draggable but doesn't reserve space.
- Fix: `padding-top: 30px` on `.helm-sidebar h1` (or the sidebar) so traffic lights have breathing room.

P2-2 — **Code/copy text uses 12px font size everywhere; some places it's the only signal**
- File: `web/src/styles/app.css:80–83`
- 12px monospace is small for a 13-year-old MacBook Pro Retina; some chat ids and tokens become fuzzy.
- Fix: bump `code, pre` to 12.5px / 13px in the `--font-mono` rule. Tradeoff: dense data tables take a touch more vertical space.

P2-3 — **Status dots are static**
- Visual: the `helm-status` dot is a flat color circle. macOS HIG-feel apps subtly shadow / glow status indicators.
- Fix: add `box-shadow: 0 0 0 2px <color>22` to the dot for a soft halo. Costs nothing.

P2-4 — **Cards in the Approvals list have no entry animation**
- File: `web/src/pages/Approvals.tsx:65–73`
- New approvals just appear. A small `animation: slide-in 200ms ease-out` would help users notice incoming items.
- Fix: define `@keyframes helm-card-enter` (translateY(-6px) + opacity 0 → identity) and apply to `.helm-card.entering`. Approvals page tags newly-arrived items briefly.

P2-5 — **The `revert` button on Settings uses the default unstyled appearance vs the primary Save**
- File: `web/src/pages/Settings.tsx:264–266`
- Working as designed (secondary action) but feels lopsided. A `.button` (the default class) is fine, just verify it visually balances with primary.

P2-6 — **Page-level vertical rhythm is too tight**
- File: `web/src/styles/app.css:142–155`
- `padding: 28px 32px` is reasonable. But `h2` margin-bottom 4px + `p.muted` margin-bottom 22px = the description and subsequent content jam together. Some pages benefit from 32px between description and first card.
- Fix: increase `.muted` `margin-bottom` to 28px.

P2-7 — **CycleDetail status pill is mid-paragraph**
- File: `web/src/pages/CycleDetail.tsx:80–87`
- `<p className="muted">` containing both `<StatusPill>` AND start-time string with margin-left adds visual debt — the pill is a badge, not inline text.
- Fix: move the pill out of the paragraph into a sibling div with `display: flex; gap: 12px; align-items: center;`.

---

## What works well

- The CSS variable system is clean and exhaustive — adding focus rings + input styles touches one file
- `prefers-color-scheme` mapping is symmetric — no hard-coded colors leaking
- `helm-status` pattern is reused everywhere and reads consistently
- Sidebar nav badge at `/approvals` is a thoughtful detail
- Card-based density is right for a developer tool (more info per pixel than a consumer app)
- Mac-specific touches present: `-webkit-app-region: drag`, SF font stack, system colors, no chrome on inputs

## Priority recommendations (top 5 to merge)

1. **P0-1 + P0-2** — focus-visible + input styles (one CSS edit, lifts every page)
2. **P0-3 + P0-6** — dark-mode contrast fixes
3. **P0-4 + P0-5** — button hierarchy: ghost / outline-danger variants
4. **P1-2 + P1-3 + P1-4** — empty-state pattern + Settings sectioning + sidebar footer
5. **P1-6 + P1-7 + P1-8** — Settings page UX micropolish: copy / loading / auto-dismiss

P2 items defer; total visible polish from P0+P1 makes the app feel ~2x more mature without restructuring routes or adding deps.
