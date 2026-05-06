import { describe, expect, it } from 'vitest';
import { buildTrayMenu, computeTrayState } from '../../../src/app/tray-state.js';

describe('computeTrayState — happy levels', () => {
  it('idle when no chats / no approvals / healthy', () => {
    const s = computeTrayState({ pendingApprovals: 0, activeChats: 0 });
    expect(s.level).toBe('idle');
    expect(s.attention).toBe(false);
    expect(s.title).toBe('Helm');
  });

  it('active when chats exist but no approvals', () => {
    const s = computeTrayState({ pendingApprovals: 0, activeChats: 2 });
    expect(s.level).toBe('active');
    expect(s.tooltip).toBe('2 chats active');
  });

  it('attention when 1 approval pending — count rendered in title', () => {
    const s = computeTrayState({ pendingApprovals: 1, activeChats: 1 });
    expect(s.level).toBe('attention');
    expect(s.title).toBe('Helm 1');
    expect(s.tooltip).toBe('1 approval pending');
    expect(s.attention).toBe(true);
  });

  it('attention with N approvals — pluralized tooltip', () => {
    const s = computeTrayState({ pendingApprovals: 3, activeChats: 0 });
    expect(s.title).toBe('Helm 3');
    expect(s.tooltip).toBe('3 approvals pending');
  });
});

describe('computeTrayState — error precedence', () => {
  it('bridgeHealthy=false dominates approvals', () => {
    const s = computeTrayState({ pendingApprovals: 5, activeChats: 0, bridgeHealthy: false });
    expect(s.level).toBe('error');
    expect(s.tooltip).toContain('bridge');
  });

  it('larkConnected=false dominates active chats', () => {
    const s = computeTrayState({ pendingApprovals: 0, activeChats: 2, larkConnected: false });
    expect(s.level).toBe('error');
    expect(s.tooltip).toContain('Lark');
  });

  it('larkConnected=undefined (Lark disabled) does not trigger error', () => {
    const s = computeTrayState({ pendingApprovals: 0, activeChats: 0, larkConnected: undefined });
    expect(s.level).toBe('idle');
  });

  it('attack: negative inputs are clamped to 0', () => {
    const s = computeTrayState({ pendingApprovals: -5, activeChats: -2 });
    expect(s.level).toBe('idle');
  });
});

describe('buildTrayMenu', () => {
  it('header summary + Open Dashboard always present', () => {
    const items = buildTrayMenu({ pendingApprovals: 0, activeChats: 0 });
    const labels = items.map((i) => i.label);
    expect(labels).toContain('Open Dashboard');
    expect(labels).toContain('Settings…');
    expect(labels).toContain('Quit Helm');
  });

  it('Open Approvals appears only when there are pending approvals', () => {
    const noPending = buildTrayMenu({ pendingApprovals: 0, activeChats: 0 });
    expect(noPending.some((i) => i.id === 'open-approvals')).toBe(false);

    const withPending = buildTrayMenu({ pendingApprovals: 2, activeChats: 0 });
    const item = withPending.find((i) => i.id === 'open-approvals');
    expect(item?.label).toBe('Open Approvals (2)');
  });

  it('Pause/Resume toggle reflects approvalsPaused', () => {
    const running = buildTrayMenu({ pendingApprovals: 0, activeChats: 0, approvalsPaused: false });
    expect(running.some((i) => i.id === 'pause-approvals')).toBe(true);
    expect(running.some((i) => i.id === 'resume-approvals')).toBe(false);

    const paused = buildTrayMenu({ pendingApprovals: 0, activeChats: 0, approvalsPaused: true });
    expect(paused.some((i) => i.id === 'resume-approvals')).toBe(true);
    expect(paused.some((i) => i.id === 'pause-approvals')).toBe(false);
  });

  it('uses computeTrayState tooltip as the disabled header label', () => {
    const items = buildTrayMenu({ pendingApprovals: 1, activeChats: 0 });
    expect(items[0]?.label).toBe('1 approval pending');
    expect(items[0]?.enabled).toBe(false);
  });

  it('separators are emitted as id="separator"', () => {
    const items = buildTrayMenu({ pendingApprovals: 0, activeChats: 0 });
    expect(items.some((i) => i.id === 'separator')).toBe(true);
  });
});
