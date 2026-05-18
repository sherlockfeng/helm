# helm-app — UI Kit

A high-fidelity, click-through recreation of the **helm** desktop app following the design system in this project. Built for design-handoff: pixel-accurate visuals, simulated interactivity, ~0 real wiring.

## What's in `index.html`

Open `index.html` and you'll see the proposed redesign live:

- **Sidebar IA** with the new `KNOWLEDGE` group (Roles · Subscriptions · Plugins lifted out of Settings).
- **Rail + content + inspector** workspace pattern on Active Chats, Roles, Approvals.
- **Stat-tile page header** on every workspace page.
- **lucide icons** wired throughout.
- **Card variants**: warn (expiring approvals), danger (destructive sections), success (just-completed banners), interactive (clickable rows).
- **Tabs** as a segmented control (replaces the hand-rolled aria-pressed tabs in Roles).
- **Toasts** that slide in from bottom-right.
- **Modal** with proper focus trap and Esc to close.
- **Light + dark** via `prefers-color-scheme`.

## Files

```
index.html                     entry — boots React + Babel, mounts <App/>
components/
  Shell.jsx                    sidebar + content + inspector
  Sidebar.jsx                  new IA, with KNOWLEDGE group
  Primitives.jsx               Button, Badge, Card, Input, Tabs, StatTile,
                               Toast, Skeleton, EmptyState
  Icons.jsx                    inline lucide SVGs used in the kit
  Modal.jsx                    confirm + form modal primitive
pages/
  ApprovalsPage.jsx
  ActiveChatsPage.jsx
  RolesPage.jsx
  HarnessPage.jsx
  SettingsPage.jsx
  SubscriptionsPage.jsx
  PluginsPage.jsx
  BindingsPage.jsx
app.css                        ports colors_and_type.css + layout chrome
```

## Differences from the current helm

This is **the proposed redesign**, not a clone of today. Specifically:

| Today | Redesign | Why |
|---|---|---|
| Roles + Subscriptions + Plugins all in Settings | `KNOWLEDGE` group in sidebar | Brief §4 — surfaces buried in Settings need to surface as nav. |
| Single `.helm-card` look | 6 card variants (default, interactive, selected, warn, danger, success) | Brief §6 #8 — no semantic differentiation today. |
| `window.confirm()` | Modal with focus trap | Brief §6 #1 — 5 places to fix. |
| `<select>` for "+ Add role" | Combobox (searchable) | Brief §6 #4. |
| `title="…"` tooltips | Radix Tooltip on icon-only buttons (simulated here) | Brief §6 #2. |
| Hand-rolled tabs | shadcn `Tabs` (segmented variant) | Brief §6 #5. |
| Errors as inline `<p>` red | Toast layer at bottom-right | Brief §6 #11. |
| One `.helm-card` per page section | Stat-tile header + rail + content + inspector | Brief §7. |

## What this UI kit is NOT

- Not real backend wiring — every action is a `setState` simulation.
- Not full feature coverage — Harness is a single screen, not the full review subprocess flow.
- Not animated to spec — motion durations are the design-system values but I haven't choreographed every list reorder.
