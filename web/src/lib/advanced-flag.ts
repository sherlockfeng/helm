/**
 * `helm.ui.advanced` localStorage flag — controls whether the sidebar
 * shows the Advanced group (Approvals / Bindings / Harness).
 *
 * The routes for those pages always work; this flag only controls nav
 * visibility. See `web/src/pages/SettingsAdvanced.tsx` for the user-
 * facing toggle and design §13.1 for the first-launch migration card.
 *
 * Default behaviour:
 *   - If the user has historical data in any "advanced" surface
 *     (approvals.length > 0 OR harness has tasks), auto-enable on first
 *     read so existing power users don't suddenly lose their nav.
 *   - Otherwise default to off — new users get the simplified IA.
 *
 * The auto-enable decision runs once and persists; subsequent reads
 * just return the stored value.
 */

const STORAGE_KEY = 'helm.ui.advanced';

/**
 * Sync read of current state.  Returns false if window is undefined
 * (SSR / vitest non-jsdom env).
 */
export function isAdvancedEnabled(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  return window.localStorage.getItem(STORAGE_KEY) === '1';
}

export function setAdvancedEnabled(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (enabled) window.localStorage.setItem(STORAGE_KEY, '1');
  else window.localStorage.removeItem(STORAGE_KEY);
  // Notify listeners (Layout subscribes) — `storage` event doesn't fire
  // in the same tab, so we dispatch a synthetic one.
  window.dispatchEvent(new CustomEvent('helm:advanced-changed', { detail: enabled }));
}

/**
 * Auto-enable on first launch if user clearly relies on Advanced
 * surfaces. Called once at app boot from `Layout`. Caller passes the
 * signal (e.g. pending-approvals count) — keeps this module free of
 * fetch logic for testability.
 */
export function autoEnableIfHistoricalData(signal: { hasHistoricalAdvancedData: boolean }): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (window.localStorage.getItem(STORAGE_KEY) !== null) return; // already decided
  if (signal.hasHistoricalAdvancedData) {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } else {
    // Persist an explicit '0' so the decision is recorded — next time
    // we don't auto-flip when historical data drops to zero.
    window.localStorage.setItem(STORAGE_KEY, '0');
  }
}
