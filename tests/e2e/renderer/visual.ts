/**
 * Visual / style regression (layer 2).
 *
 * Pixel-compares a viewport screenshot against a committed baseline so a
 * pure-CSS change that drifts layout/spacing/colour — invisible to tsc, the
 * happy-dom component tests, and even the functional smoke (which only
 * asserts text/structure) — fails CI.
 *
 * Baselines MUST be generated on the CI OS: macOS-runner font rendering
 * differs from a dev laptop, so a locally-captured baseline would mismatch
 * every CI run. Flow:
 *   1. First CI run finds no baseline → writes it, uploads as artifact, passes.
 *   2. Download the `renderer-screenshots` artifact, commit the PNGs under
 *      tests/e2e/renderer/__baselines__/, push.
 *   3. Subsequent runs pixel-compare against the committed baseline.
 * Regenerate after an intentional UI change (or a runner image bump) by
 * re-running with UPDATE_SNAPSHOTS=1 and committing the new baselines.
 *
 * Viewport (not full-page) screenshots keep dimensions fixed run-to-run so
 * a content-height delta doesn't masquerade as a visual diff. A 1% pixel
 * tolerance absorbs sub-pixel antialiasing without hiding real shifts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const BASELINE_DIR = join(__dirname, '__baselines__');
const DIFF_DIR = join(__dirname, '__screenshots__', 'diffs');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
/** Fraction of pixels allowed to differ before a page is flagged. */
const MAX_DIFF_RATIO = 0.01;

export async function assertScreenshot(page: Page, name: string): Promise<void> {
  const actualBuf = await page.screenshot({ fullPage: false });
  const baselinePath = join(BASELINE_DIR, `${name}.png`);

  if (UPDATE || !existsSync(baselinePath)) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, actualBuf);
    // eslint-disable-next-line no-console
    console.log(`[visual] baseline ${UPDATE ? 'updated' : 'created'}: ${name}`);
    return;
  }

  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const actual = PNG.sync.read(actualBuf);

  // A dimension change is itself a regression (or an intentional layout
  // change needing a baseline refresh) — fail loudly rather than crash
  // pixelmatch on mismatched buffers.
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    mkdirSync(DIFF_DIR, { recursive: true });
    writeFileSync(join(DIFF_DIR, `${name}.actual.png`), actualBuf);
    expect.fail(
      `visual "${name}": size changed ${baseline.width}x${baseline.height} → `
      + `${actual.width}x${actual.height}. If intentional, regenerate baselines `
      + `(UPDATE_SNAPSHOTS=1).`,
    );
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(baseline.data, actual.data, diff.data, width, height, { threshold: 0.1 });
  const ratio = mismatched / (width * height);

  if (ratio > MAX_DIFF_RATIO) {
    mkdirSync(DIFF_DIR, { recursive: true });
    writeFileSync(join(DIFF_DIR, `${name}.actual.png`), actualBuf);
    writeFileSync(join(DIFF_DIR, `${name}.diff.png`), PNG.sync.write(diff));
  }

  expect(
    ratio,
    `visual diff for "${name}": ${(ratio * 100).toFixed(3)}% of pixels changed `
    + `(> ${MAX_DIFF_RATIO * 100}% allowed). See __screenshots__/diffs/${name}.diff.png. `
    + `If intentional, regenerate baselines (UPDATE_SNAPSHOTS=1).`,
  ).toBeLessThanOrEqual(MAX_DIFF_RATIO);
}
