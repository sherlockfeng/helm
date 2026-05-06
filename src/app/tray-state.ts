/**
 * Pure logic for the macOS menubar tray state.
 *
 * Inputs (live counts + healthchecks) → output (title text shown in the
 * menubar + tooltip + status level for icon coloring). Kept dep-free so
 * Electron's Tray wiring (electron/tray.ts) can call this on every state
 * change and tests can verify all branches without spinning Electron.
 *
 * Status levels (per PROJECT_BLUEPRINT.md §14.1):
 *   - idle      app running, no activity              → grey dot
 *   - active    1+ active chats                       → blue dot
 *   - attention 1+ pending approvals                  → yellow + count
 *   - error     bridge or lark connection broken      → red
 *
 * Precedence: error > attention > active > idle. So a bridge crash with
 * pending approvals shows red (the urgent failure dominates the urgent
 * action).
 */

export type TrayLevel = 'idle' | 'active' | 'attention' | 'error';

export interface TrayStateInputs {
  pendingApprovals: number;
  activeChats: number;
  /** Bridge socket healthy. Defaults to true. */
  bridgeHealthy?: boolean;
  /**
   * Lark listener connected. `undefined` = lark disabled (don't show as
   * an error). `false` = configured but disconnected.
   */
  larkConnected?: boolean;
}

export interface TrayState {
  /** Title shown in the menubar (macOS template image accompanies). */
  title: string;
  tooltip: string;
  level: TrayLevel;
  /** Whether the icon should pulse / draw user attention. */
  attention: boolean;
}

export function computeTrayState(input: TrayStateInputs): TrayState {
  const pending = Math.max(0, input.pendingApprovals);
  const active = Math.max(0, input.activeChats);
  const bridgeHealthy = input.bridgeHealthy ?? true;
  const larkBroken = input.larkConnected === false;

  // Error precedence first.
  if (!bridgeHealthy) {
    return {
      title: '⚠ Helm',
      tooltip: 'Helm bridge disconnected',
      level: 'error',
      attention: true,
    };
  }
  if (larkBroken) {
    return {
      title: '⚠ Helm',
      tooltip: 'Lark listener disconnected',
      level: 'error',
      attention: true,
    };
  }

  if (pending > 0) {
    return {
      title: pending === 1 ? 'Helm 1' : `Helm ${pending}`,
      tooltip: `${pending} approval${pending === 1 ? '' : 's'} pending`,
      level: 'attention',
      attention: true,
    };
  }

  if (active > 0) {
    return {
      title: 'Helm',
      tooltip: `${active} chat${active === 1 ? '' : 's'} active`,
      level: 'active',
      attention: false,
    };
  }

  return {
    title: 'Helm',
    tooltip: 'Helm — no activity',
    level: 'idle',
    attention: false,
  };
}

/**
 * Tray menu structure. Labels only — Electron's tray.ts builds the
 * Menu.buildFromTemplate items; tests inspect this shape directly.
 */
export interface TrayMenuItem {
  label: string;
  /** Identifier the click handler dispatches on. */
  id: 'open-dashboard' | 'open-approvals' | 'open-settings' | 'pause-approvals' | 'resume-approvals' | 'quit' | 'separator';
  enabled?: boolean;
}

export interface BuildTrayMenuOptions extends TrayStateInputs {
  approvalsPaused?: boolean;
}

export function buildTrayMenu(input: BuildTrayMenuOptions): TrayMenuItem[] {
  const items: TrayMenuItem[] = [];
  const state = computeTrayState(input);
  const summary = state.tooltip;
  // Header is a disabled item that surfaces the same summary as the tooltip
  // for users on platforms where tooltips are slow / hidden.
  items.push({ label: summary, id: 'open-dashboard', enabled: false });
  items.push({ label: '', id: 'separator' });
  items.push({ label: 'Open Dashboard', id: 'open-dashboard' });
  if (input.pendingApprovals > 0) {
    items.push({ label: `Open Approvals (${input.pendingApprovals})`, id: 'open-approvals' });
  }
  items.push({ label: '', id: 'separator' });
  items.push({
    label: input.approvalsPaused ? 'Resume Approvals' : 'Pause Approvals',
    id: input.approvalsPaused ? 'resume-approvals' : 'pause-approvals',
  });
  items.push({ label: 'Settings…', id: 'open-settings' });
  items.push({ label: '', id: 'separator' });
  items.push({ label: 'Quit Helm', id: 'quit' });
  return items;
}
