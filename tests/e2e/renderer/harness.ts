/**
 * Shared launch harness for the renderer e2e specs.
 *
 * happy.spec.ts (functional smoke) keeps its own inline boot — it's the
 * canonical, battle-tested one and I don't want to risk it. This helper
 * exists so NEW specs (visual.spec.ts) can cold-boot the same real
 * Electron app without copy-pasting the env wiring.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'out', 'electron', 'main.cjs');

export interface Renderer {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  consoleMessages: string[];
  pageErrors: string[];
}

export async function launchRenderer(): Promise<Renderer> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'helm-renderer-e2e-'));
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  const app = await electron.launch({
    args: [ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Disable the single-instance lock so this coexists with a dev Helm.
      HELM_E2E: '1',
      // Fresh tmpdir for SQLite WAL / bridge socket / logs.
      HELM_HOME: userDataDir,
      // Force the production file:// path even if the dev has HELM_DEV set.
      HELM_DEV: '',
    },
  });
  app.process().stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('lark-cli exited')) process.stderr.write(`[helm-stderr] ${text}`);
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  page.on('console', (m) => consoleMessages.push(`${m.type()}:${m.text()}`));
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userDataDir, consoleMessages, pageErrors };
}

/** Navigate by hash (HashRouter) and wait for the page heading to render. */
export async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.evaluate((r) => { location.hash = `#${r}`; }, route);
  await page.waitForFunction(
    () => Boolean(document.querySelector('main.helm-main h2')),
    { timeout: 10_000 },
  );
}
