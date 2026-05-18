---
name: helm-design
description: Use this skill to generate well-branded interfaces and assets for helm (the macOS Electron control panel for AI coding agents), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `README.md` file within this skill first, then explore:

- `CODEBASE-NOTES.md` — **if you're working in the helm repo, read this immediately.** Maps every design proposal to the file + line in `helm/web/src/` it touches. Calls out what's already shipped (Phase 79, polish-pass, a11y-audit) so you don't re-do work.
- `HANDOFF.md` — implementer-facing spec: IA tree, page templates, primitive choices, **9-PR migration plan**. Each PR has acceptance criteria.
- `colors_and_type.css` — the canonical token set (colors, type, spacing, radii, shadows, motion). Base tokens match `web/src/styles/app.css` exactly; the "NEW" tokens (spacing, motion, semantic tints, type scale, popover/modal shadows) extend it. Never invent new hexes.
- `ICONOGRAPHY.md` — icon system rules (lucide, 1.75 stroke, no emoji, canonical concept→icon mapping).
- `assets/glyph.svg`, `assets/logo.svg` — brand mark + wordmark. Monochrome via `currentColor`.
- `ui_kits/helm-app/` — high-fidelity React-in-Babel recreation of every key screen with the proposed redesign. Read `ui_kits/helm-app/README.md` for what's in scope.
- `preview/` — small standalone HTML cards demonstrating every primitive in isolation. Use these as visual references when assembling new screens.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc.), copy assets out and create static HTML files for the user to view. If working on production code (the helm Electron app), read `CODEBASE-NOTES.md` first, then port the new tokens into `web/src/styles/app.css` under the existing `@theme inline` block, and follow the 9-PR migration plan in `HANDOFF.md`.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask focused questions (which page? which state? what's the tone — system app or marketing surface?), then act as an expert designer who outputs either HTML artifacts or production code, depending on the need.

**helm design rules of thumb:**

- Two surface colors per screen, max. One semantic tone unless the screen is genuinely communicating multiple states.
- No emoji. No gradients (except the 1 px sticky-header protection gradient). No hand-rolled SVGs apart from the brand glyph.
- All borders are hairlines (`--border`, 1 px). All shadows come from the 3-rung shadow scale.
- All motion uses the 3-rung duration scale (`80ms / 160ms / 240ms`) and respects `prefers-reduced-motion`.
- The brand is **lowercase helm**, always. The mark is a 1.5 px stroke ship's helm wheel.
- Voice is steady, local, honest. Numerals not words. Sentence case for body, Title Case for nav and primary buttons.
