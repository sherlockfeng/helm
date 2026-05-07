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
let window: Page;
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

  window = await app.firstWindow({ timeout: 60_000 });
  window.on('console', (m) => consoleMessages.push(`${m.type()}:${m.text()}`));
  window.on('pageerror', (err) => pageErrors.push(err.message));
  await window.waitForLoadState('domcontentloaded');
}, 90_000);

afterAll(async () => {
  // Always dump the final state for debugging, even on success.
  try {
    if (window && !window.isClosed()) {
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
  it('window paints, sidebar + every nav entry, /approvals empty state, router navigates, no JS errors', async () => {
    // ── 1. Sidebar + initial Approvals page ────────────────────────────
    await window.waitForSelector('h1', { timeout: 30_000 });
    await window.screenshot({
      path: join(SCREENSHOT_DIR, 'approvals-loaded.png'),
      fullPage: true,
    });

    // <h1>Helm</h1> in the sidebar — the bare-minimum-rendered signal.
    expect((await window.locator('h1').first().textContent())?.trim()).toBe('Helm');

    // Every nav entry the user expects must be present. Catches a Layout
    // refactor that silently drops a route.
    const navText = await window.locator('nav.helm-nav').textContent();
    for (const label of ['Approvals', 'Active Chats', 'Bindings', 'Campaigns', 'Roles', 'Requirements', 'Settings']) {
      expect(navText, `nav missing "${label}"`).toContain(label);
    }

    // The Approvals page is the index target — heading must read "Approvals",
    // not stay blank or render a router fallback.
    expect(
      (await window.locator('main.helm-main h2').first().textContent())?.trim(),
    ).toBe('Approvals');

    // Wait for backend connectivity confirmation. The "Connected" pill
    // proves the renderer's API client (web/src/api/base-url.ts) actually
    // reached the helm HTTP server — the white-screen / "Backend offline"
    // bug we wrote this suite to catch.
    await window.waitForFunction(
      () => /Connected/.test(document.querySelector('.helm-status')?.textContent ?? ''),
      { timeout: 15_000 },
    );

    // Empty-state landed instead of a stale loading spinner.
    await window.waitForFunction(
      () => /No pending approvals/.test(document.querySelector('main.helm-main')?.textContent ?? ''),
      { timeout: 5000 },
    );

    // ── 2. Router survives file:// (Active Chats) ──────────────────────
    await window.click('a[href="/chats"]');
    await window.waitForFunction(
      () => document.querySelector('main.helm-main h2')?.textContent?.trim() === 'Active Chats',
      { timeout: 5000 },
    );
    await window.screenshot({
      path: join(SCREENSHOT_DIR, 'chats-loaded.png'),
      fullPage: true,
    });

    // ── 3. Walk through the rest so a screenshot lands per page ────────
    for (const route of ['/bindings', '/campaigns', '/roles', '/requirements', '/settings']) {
      await window.click(`a[href="${route}"]`);
      // Each page renders a top-level <h2>; wait for it before screenshotting.
      await window.waitForFunction(
        () => Boolean(document.querySelector('main.helm-main h2')),
        { timeout: 5000 },
      );
      const slug = route.replace(/^\//, '') || 'root';
      await window.screenshot({
        path: join(SCREENSHOT_DIR, `${slug}-loaded.png`),
        fullPage: true,
      });
    }

    // ── 4. No red-screen-of-death equivalent ───────────────────────────
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
