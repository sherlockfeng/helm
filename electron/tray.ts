/**
 * macOS menubar tray glue. Pure tray state logic lives in
 * `src/app/tray-state.ts`; this file is the Electron-specific shell that
 * subscribes to live counts + drives the Tray + Menu APIs.
 *
 * Design notes:
 *   - Title-text + transparent icon: macOS displays the title string in the
 *     menubar (e.g. "Helm 2"), so we can communicate state without shipping
 *     image assets. A transparent template image keeps the title aligned.
 *   - Click on the tray icon shows the menu; Open Dashboard menu item opens
 *     the main BrowserWindow.
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import {
  buildTrayMenu,
  computeTrayState,
  type TrayMenuItem,
  type TrayStateInputs,
} from '../src/app/tray-state.js';

export interface HelmTrayDeps {
  onOpenDashboard: () => void;
  onOpenApprovals: () => void;
  onOpenSettings: () => void;
  onPauseApprovals?: () => void;
  onResumeApprovals?: () => void;
  onQuit: () => void;
}

export interface HelmTrayHandle {
  update(input: TrayStateInputs & { approvalsPaused?: boolean }): void;
  destroy(): void;
}

function actionFor(deps: HelmTrayDeps, id: TrayMenuItem['id']): (() => void) | undefined {
  switch (id) {
    case 'open-dashboard': return deps.onOpenDashboard;
    case 'open-approvals': return deps.onOpenApprovals;
    case 'open-settings': return deps.onOpenSettings;
    case 'pause-approvals': return deps.onPauseApprovals;
    case 'resume-approvals': return deps.onResumeApprovals;
    case 'quit': return deps.onQuit;
    default: return undefined;
  }
}

function toMenuTemplate(items: TrayMenuItem[], deps: HelmTrayDeps): MenuItemConstructorOptions[] {
  return items.map<MenuItemConstructorOptions>((item) => {
    if (item.id === 'separator') return { type: 'separator' };
    const click = actionFor(deps, item.id);
    return {
      label: item.label,
      enabled: item.enabled !== false && Boolean(click),
      click: click ? () => click() : undefined,
    };
  });
}

export function setupHelmTray(deps: HelmTrayDeps): HelmTrayHandle {
  // Empty 16x16 transparent template — macOS shows the title text alongside.
  // Image must be a NativeImage; createEmpty produces a valid 0x0 placeholder
  // which macOS treats as "no icon, just the title".
  const icon = nativeImage.createEmpty();
  const tray = new Tray(icon);

  let lastInput: TrayStateInputs & { approvalsPaused?: boolean } = {
    pendingApprovals: 0, activeChats: 0,
  };

  function render(): void {
    const state = computeTrayState(lastInput);
    tray.setTitle(state.title);
    tray.setToolTip(state.tooltip);
    const items = buildTrayMenu(lastInput);
    tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(items, deps)));
  }

  render();

  return {
    update(input): void {
      lastInput = { ...lastInput, ...input };
      render();
    },
    destroy(): void {
      tray.destroy();
    },
  };
}
