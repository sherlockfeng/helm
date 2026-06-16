import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { openAssistant } = vi.hoisted(() => ({ openAssistant: vi.fn() }));
vi.mock('../components/assistant-bus.js', () => ({ openAssistant, onOpenAssistant: () => () => {} }));

import { RoleActionsMenu } from './Roles.js';
import type { RoleSummary } from '../api/types.js';

/**
 * Layer-1 component test for the role-card ⋯ menu.
 *
 * RoleActionsMenu is the piece with the most conditional wiring — which
 * items appear depends on isBuiltin / bindable / tier / mergeTargets, and
 * each item must call the right handler. A pure-props component like this
 * is exactly what fast happy-dom tests guard: a refactor that drops an
 * action or mis-wires a handler fails here in milliseconds instead of
 * surfacing as a broken button in the live app.
 */

function makeRole(overrides: Partial<RoleSummary> = {}): RoleSummary {
  return {
    id: 'goofy-expert', name: 'Goofy 专家', systemPrompt: 'You are Goofy.',
    isBuiltin: false, createdAt: '2026-01-01T00:00:00Z', version: 1,
    bindable: true, chunkCount: 96, pendingCandidateCount: 0, tier: 'personal',
    ...overrides,
  };
}

function setup(role: RoleSummary, mergeTargets: { value: string; label: string }[] = []) {
  const handlers = {
    onUpdateViaChat: vi.fn(), onPromote: vi.fn(),
    onToggleBindable: vi.fn(), onConfigurePersona: vi.fn(),
    onDelete: vi.fn(), onMerge: vi.fn(), onRename: vi.fn(),
  };
  render(<RoleActionsMenu role={role} mergeTargets={mergeTargets} {...handlers} />);
  return handlers;
}

describe('RoleActionsMenu', () => {
  it('renders nothing for built-in roles (no applicable actions)', () => {
    const { container } = render(
      <RoleActionsMenu
        role={makeRole({ isBuiltin: true })}
        mergeTargets={[]}
        onUpdateViaChat={vi.fn()} onPromote={vi.fn()}
        onToggleBindable={vi.fn()} onConfigurePersona={vi.fn()}
        onDelete={vi.fn()} onMerge={vi.fn()} onRename={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('配置人格 (pure topic) calls onConfigurePersona, not the plain bindable flip', async () => {
    const h = setup(makeRole({ bindable: false }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '配置人格…' }));
    expect(h.onConfigurePersona).toHaveBeenCalledTimes(1);
    expect(h.onToggleBindable).not.toHaveBeenCalled();
  });

  it('卸下人格 (expert) calls onToggleBindable', async () => {
    const h = setup(makeRole({ bindable: true }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '卸下人格' }));
    expect(h.onToggleBindable).toHaveBeenCalledTimes(1);
    expect(h.onConfigurePersona).not.toHaveBeenCalled();
  });

  it('「让助手整理」opens the assistant seeded with the topic name', async () => {
    openAssistant.mockClear();
    setup(makeRole({ name: '服务容灾专家' }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /让助手整理/ }));
    expect(openAssistant).toHaveBeenCalledTimes(1);
    expect(String(openAssistant.mock.calls[0]![0])).toContain('服务容灾专家');
  });

  it('renames via the inline input, calling onRename with the new name', async () => {
    const h = setup(makeRole({ name: 'Goofy 专家' }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名…' }));
    const input = screen.getByPlaceholderText('新名称') as HTMLInputElement;
    expect(input.value).toBe('Goofy 专家'); // seeded with the current name
    await userEvent.clear(input);
    await userEvent.type(input, '服务容灾专家');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(h.onRename).toHaveBeenCalledWith('服务容灾专家');
  });

  it('does not call onRename when the name is unchanged or blank', async () => {
    const h = setup(makeRole({ name: 'Goofy 专家' }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名…' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' })); // unchanged
    expect(h.onRename).not.toHaveBeenCalled();
  });

  it('keeps the menu closed until the ⋯ trigger is clicked', async () => {
    setup(makeRole());
    expect(screen.getByRole('button', { name: '更多操作' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('shows expert actions (通过对话更新 + 卸下人格) for a bindable role', async () => {
    setup(makeRole({ bindable: true }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: '通过对话更新' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '卸下人格' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '配置人格' })).not.toBeInTheDocument();
  });

  it('shows 配置人格 (not 通过对话更新) for a pure topic', async () => {
    setup(makeRole({ bindable: false }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: '配置人格…' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '通过对话更新' })).not.toBeInTheDocument();
  });

  it('hides 贡献到团队层 for team-tier topics', async () => {
    setup(makeRole({ tier: 'team' }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.queryByRole('menuitem', { name: '贡献到团队层…' })).not.toBeInTheDocument();
  });

  it('shows 贡献到团队层 for personal-tier topics', async () => {
    setup(makeRole({ tier: 'personal' }));
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: '贡献到团队层…' })).toBeInTheDocument();
  });

  it('calls onDelete when 删除 is clicked', async () => {
    const h = setup(makeRole());
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it('hides the merge entry when there are no merge targets', async () => {
    setup(makeRole(), []);
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.queryByRole('menuitem', { name: /合并到…/ })).not.toBeInTheDocument();
  });

  it('expands the merge sub-list and calls onMerge with the picked target', async () => {
    const targets = [
      { value: 'og-网关与-decc-打标', label: 'OG 网关与 DECC 打标' },
      { value: 'stability', label: 'Stability' },
    ];
    const h = setup(makeRole(), targets);
    await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
    // Sub-list is collapsed until the merge entry is clicked.
    expect(screen.queryByRole('menuitem', { name: 'OG 网关与 DECC 打标' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /合并到…/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'OG 网关与 DECC 打标' }));
    expect(h.onMerge).toHaveBeenCalledWith('og-网关与-decc-打标', 'OG 网关与 DECC 打标');
  });
});
