/**
 * Layer-2 visual regression — separate spec (own Electron boot) so a pixel
 * diff can never break the functional smoke in happy.spec.ts. See visual.ts
 * for the baseline lifecycle.
 *
 * Only stable empty-state pages are snapshotted: a fresh HELM_HOME tmpdir
 * means no conversations / cases / runs, so there's no per-run dynamic
 * content (timestamps, counts) to make the baseline flap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchRenderer, gotoRoute, type Renderer } from './harness.js';
import { assertScreenshot } from './visual.js';

let r: Renderer;

beforeAll(async () => {
  r = await launchRenderer();
  // Wait for the backend "Connected" pill so we don't snapshot the
  // transient "offline" state.
  await r.page.waitForSelector('h1', { timeout: 30_000 });
  await r.page.waitForFunction(
    () => /Connected/.test(document.querySelector('.helm-status')?.textContent ?? ''),
    { timeout: 20_000 },
  );
}, 90_000);

afterAll(async () => {
  await r?.app?.close().catch(() => {/* already closed */});
});

describe('renderer visual regression', () => {
  it('empty-state pages match their committed baselines', async () => {
    const pages: Array<{ route: string; name: string }> = [
      { route: '/conversations', name: 'conversations-empty' },
      { route: '/knowledge/library', name: 'knowledge-library-empty' },
      { route: '/verification/cases', name: 'verification-cases-empty' },
      { route: '/settings', name: 'settings' },
    ];
    for (const { route, name } of pages) {
      await gotoRoute(r.page, route);
      // Let skeletons / async lists settle before capturing.
      await r.page.waitForFunction(
        () => document.querySelectorAll('[data-skeleton], .helm-skeleton').length === 0,
        { timeout: 10_000 },
      ).catch(() => {/* no skeletons on this page */});
      await assertScreenshot(r.page, name);
    }
    // The diff helper throws on mismatch; reaching here means all matched
    // (or baselines were just seeded in bootstrap/update mode).
    expect(true).toBe(true);
  }, 60_000);
});
