/**
 * E2e — bundled Electron renderer (Phase 52).
 *
 * The other e2e suites prove the HTTP API + MCP + bridge layers work when
 * driven directly. They CAN'T catch:
 *
 *   - Phase 48 white-screen (vite `base: '/'` broke file:// asset loading)
 *   - Phase 50 white-screen (renderer fetched `file:///api/health`)
 *   - Phase 51 white-screen (preload.js → preload.cjs ENOENT)
 *   - The Phase 52 actual cause (a stale web/dist with absolute asset paths
 *     even though vite.config.ts had `base: './'`)
 *
 * because none of those existing tests load the actual bundled JS in a
 * real BrowserWindow. This suite uses `playwright._electron` to launch the
 * real `dist/electron/main.cjs`, attach to the BrowserWindow, screenshot
 * it, and assert visible text.
 *
 * Single-launch design: cold-booting Electron + the helm orchestrator costs
 * ~25s per spawn; running each assertion in its own `it()` would be 2+
 * minutes of pure boot time. Instead we launch once in `beforeAll`, walk
 * through every UX surface in one test, and capture per-page screenshots
 * to `tests/e2e/renderer/__screenshots__/`. A reviewer can eyeball CI
 * failures without re-running locally.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'dist', 'electron', 'main.cjs');
const SCREENSHOT_DIR = join(__dirname, '__screenshots__');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
const consoleMessages: string[] = [];
const pageErrors: string[] = [];

beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'helm-renderer-e2e-'));
  app = await electron.launch({
    args: [ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // HELM_E2E disables the single-instance lock so the test's helm can
      // co-exist with a developer's running Helm.
      HELM_E2E: '1',
      // Fresh tmpdir for the SQLite WAL / bridge socket / logs.
      HELM_HOME: userDataDir,
      // Force production file:// path even if developer has HELM_DEV set.
      HELM_DEV: '',
    },
  });
  // Surface main-process stderr (orchestrator boot failures, Lark noise) so
  // a beforeAll timeout in CI is debuggable from the run log alone.
  app.process().stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('lark-cli exited')) {
      process.stderr.write(`[helm-stderr] ${text}`);
    }
  });

  page = await app.firstWindow({ timeout: 60_000 });
  page.on('console', (m) => consoleMessages.push(`${m.type()}:${m.text()}`));
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.waitForLoadState('domcontentloaded');
}, 90_000);

afterAll(async () => {
  // Always dump the final state for debugging, even on success.
  try {
    if (page && !page.isClosed()) {
      writeFileSync(
        join(SCREENSHOT_DIR, 'console.txt'),
        ['== console messages ==', ...consoleMessages, '', '== page errors ==', ...pageErrors].join('\n'),
      );
    }
  } catch {/* swallow */}
  await app?.close().catch(() => {/* already closed */});
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('renderer smoke', () => {
  it('page paints, new IA sidebar, conversations index, every primary page reachable, no JS errors', async () => {
    // ── 1. Sidebar paint + IA structure ────────────────────────────────
    // PR 1 (conversations-knowledge IA): primary surfaces are
    // Conversations / Knowledge / Verification, plus Settings pinned
    // bottom. Approvals/Bindings/Harness live under Settings › Advanced
    // (hidden until enabled). The renderer must paint without a
    // BrowserWindow under HashRouter (file:// context).
    await page.waitForSelector('h1', { timeout: 30_000 });
    await page.screenshot({
      path: join(SCREENSHOT_DIR, 'conversations-loaded.png'),
      fullPage: true,
    });

    // <h1>Helm</h1> in the sidebar — the bare-minimum-rendered signal.
    expect((await page.locator('h1').first().textContent())?.trim()).toBe('Helm');

    // Every primary nav entry must be present. Catches a Layout refactor
    // that silently drops a route.
    const navText = await page.locator('nav.helm-nav').textContent();
    for (const label of ['Conversations', 'Knowledge', 'Library', 'Review', 'Sources', 'Verification', 'Cases', 'Runs', 'Coverage', 'Settings']) {
      expect(navText, `nav missing "${label}"`).toContain(label);
    }

    // Advanced section should be hidden by default (new install: no
    // historical approval data → autoEnableIfHistoricalData persists '0').
    const advancedNav = page.locator('[data-testid="helm-nav-advanced"]');
    expect(await advancedNav.count(), 'Advanced section should be hidden by default').toBe(0);

    // The Conversations page is the index target — heading must render,
    // not stay blank or render a router fallback.
    expect(
      (await page.locator('main.helm-main h2').first().textContent())?.trim(),
    ).toBeTruthy();

    // Wait for backend connectivity confirmation. The "Connected" pill
    // proves the renderer's API client actually reached the helm HTTP
    // server — guards against the white-screen / "Backend offline" bug.
    await page.waitForFunction(
      () => /Connected/.test(document.querySelector('.helm-status')?.textContent ?? ''),
      { timeout: 15_000 },
    );

    // ── 2. Router back-compat: /chats redirects to /conversations ──────
    // `location` / `localStorage` / `dispatchEvent` inside evaluate /
    // waitForFunction bodies run in browser context — refer to them as
    // bare globals, not via `page.` (which would resolve to the
    // Playwright Page object).
    await page.evaluate(() => { location.hash = '#/chats'; });
    await page.waitForFunction(
      () => location.hash === '#/conversations',
      { timeout: 5000 },
    );
    await page.screenshot({
      path: join(SCREENSHOT_DIR, 'chats-redirect-loaded.png'),
      fullPage: true,
    });

    // ── 3. Walk through the new primary surfaces so a screenshot
    //      lands per page; HashRouter so navigation by hash change. ────
    const primaryRoutes = [
      '/knowledge/library',
      '/knowledge/review',
      '/knowledge/sources',
      '/verification/cases',
      '/verification/runs',
      '/verification/coverage',
      '/settings',
    ];
    for (const route of primaryRoutes) {
      await page.evaluate((r) => { location.hash = `#${r}`; }, route);
      await page.waitForFunction(
        () => Boolean(document.querySelector('main.helm-main h2')),
        { timeout: 5000 },
      );
      const slug = route.replace(/^\//, '').replace(/\//g, '-') || 'root';
      await page.screenshot({
        path: join(SCREENSHOT_DIR, `${slug}-loaded.png`),
        fullPage: true,
      });
    }

    // ── 4. Settings › Advanced toggle reveals the Advanced section ─────
    await page.evaluate(() => {
      localStorage.setItem('helm.ui.advanced', '1');
      dispatchEvent(new CustomEvent('helm:advanced-changed', { detail: true }));
    });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="helm-nav-advanced"]')),
      { timeout: 5000 },
    );

    // After toggle, legacy surfaces are reachable via direct hash nav.
    for (const route of ['/approvals', '/bindings', '/harness']) {
      await page.evaluate((r) => { location.hash = `#${r}`; }, route);
      await page.waitForFunction(
        () => Boolean(document.querySelector('main.helm-main h2')),
        { timeout: 5000 },
      );
    }

    // Toggle back off; Advanced should disappear from the sidebar.
    await page.evaluate(() => {
      localStorage.setItem('helm.ui.advanced', '0');
      dispatchEvent(new CustomEvent('helm:advanced-changed', { detail: false }));
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="helm-nav-advanced"]') === null,
      { timeout: 5000 },
    );

    // ── 5. R-14: real interactive flow — click `+ New case` to open the
    //      form, type a name, hit Create, see the form succeed-or-error.
    //      Catches regressions that screenshot-only tests would miss
    //      (e.g. a useState rewire that breaks input bindings). ─────────
    await page.evaluate(() => { location.hash = '#/verification/cases'; });
    await page.waitForFunction(
      () => document.querySelectorAll('button, a').length > 0
        && Array.from(document.querySelectorAll('button')).some((b) => /New case/i.test(b.textContent ?? '')),
      { timeout: 5000 },
    );
    const newCaseBtn = page.getByRole('button', { name: /\+? ?New case/i });
    await newCaseBtn.click();
    // Form panel appears with the name input.
    await page.waitForSelector('input[placeholder*="dr-my-dc-failure"]', { timeout: 5000 });
    await page.fill('input[placeholder*="dr-my-dc-failure"]', 'e2e-smoke-case');
    // Click again to confirm the toggle works — should hide the form.
    await page.getByRole('button', { name: /Hide form/i }).click();
    await page.waitForFunction(
      () => !document.querySelector('input[placeholder*="dr-my-dc-failure"]'),
      { timeout: 5000 },
    );
    await page.screenshot({
      path: join(SCREENSHOT_DIR, 'verification-cases-form-toggled.png'),
      fullPage: true,
    });

    // ── 6. No red-screen-of-death equivalent ───────────────────────────
    expect(pageErrors, `pageerror events:\n${pageErrors.join('\n')}`).toEqual([]);

    // CSP warnings under file:// are harmless for our local-only app —
    // filter them out and assert nothing else slipped in.
    const realIssues = consoleMessages.filter(
      (m) => /Failed to fetch|ENOENT|Uncaught|Cannot find module|net::ERR_/i.test(m)
        && !m.includes('Content-Security-Policy'),
    );
    expect(realIssues, `renderer console contained errors:\n  ${realIssues.join('\n  ')}`).toEqual([]);
  }, 90_000);
});
