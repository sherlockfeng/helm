import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the API client + toast so the component renders without a backend.
// vi.hoisted: vi.mock is hoisted above imports, so anything its factory
// references (the spies + the ApiError stand-in) must be created here, not as
// plain top-level vars (those hit the TDZ when the factory runs).
const { depositTopicKnowledge, acceptKnowledgePoint, dismissKnowledgePoint, appendPointsToRole, openAssistant, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message); this.status = status; this.body = body;
    }
  }
  return {
    depositTopicKnowledge: vi.fn(),
    acceptKnowledgePoint: vi.fn(),
    dismissKnowledgePoint: vi.fn(),
    appendPointsToRole: vi.fn(),
    openAssistant: vi.fn(),
    MockApiError,
  };
});
vi.mock('../api/client.js', () => ({
  ApiError: MockApiError,
  helmApi: {
    depositTopicKnowledge,
    extractKnowledge: vi.fn(),
    acceptKnowledgePoint,
    dismissKnowledgePoint,
    appendPointsToRole,
  },
}));
vi.mock('../components/assistant-bus.js', () => ({ openAssistant, onOpenAssistant: () => () => {} }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { KnowledgePointsSection, groupPointsByTopic, seedReorganize, buildSessionRef } from './Chats.js';
import type { ChatKnowledgePoint } from '../api/types.js';

function pt(over: Partial<ChatKnowledgePoint> & { id: string }): ChatKnowledgePoint {
  return {
    hostSessionId: 's1', title: `t-${over.id}`, body: 'b', kind: 'spec',
    suggestedRoleId: null, suggestedTopicName: null, status: 'pending',
    createdAt: '2026-01-01T00:00:00Z', ...over,
  } as ChatKnowledgePoint;
}

const ROLES = [{ id: 'svc', name: '服务容灾专家' }, { id: 'goofy', name: 'goofy_ssr' }];

describe('buildSessionRef', () => {
  it('tags the host (claude-code → Claude Code) and includes id + cwd', () => {
    const ref = buildSessionRef({ id: 'sess-1', host: 'claude-code', cwd: '/proj' });
    expect(ref).toContain('sess-1');
    expect(ref).toContain('Claude Code');
    expect(ref).toContain('/proj');
  });
  it('maps cursor / codex hosts', () => {
    expect(buildSessionRef({ id: 'x', host: 'cursor' })).toContain('Cursor');
    expect(buildSessionRef({ id: 'x', host: 'codex' })).toContain('Codex');
  });
});

describe('seedReorganize', () => {
  it('names the chat + its suggested topics in the assistant seed', () => {
    const seed = seedReorganize('sess-9', [
      pt({ id: '1', suggestedRoleId: 'svc' }),
      pt({ id: '2', suggestedTopicName: 'CONSTANTS' }),
    ], ROLES);
    expect(seed).toContain('sess-9');
    expect(seed).toContain('服务容灾专家');
    expect(seed).toContain('CONSTANTS');
  });
});

describe('groupPointsByTopic', () => {
  it('aggregates points by suggested topic, each topic once, order preserved', () => {
    const groups = groupPointsByTopic([
      pt({ id: '1', suggestedRoleId: 'svc' }),
      pt({ id: '2', suggestedRoleId: 'goofy' }),
      pt({ id: '3', suggestedRoleId: 'svc' }),
      pt({ id: '4', suggestedTopicName: 'CONSTANTS' }),
    ], ROLES);

    expect(groups.map((g) => g.label)).toEqual(['服务容灾专家', 'goofy_ssr', 'CONSTANTS']);
    expect(groups[0]!.points.map((p) => p.id)).toEqual(['1', '3']); // svc deduped into one group
    expect(groups[0]!.targetRoleId).toBe('svc');
    expect(groups[2]!.newTopicName).toBe('CONSTANTS'); // new-topic suggestion
  });
});

describe('KnowledgePointsSection', () => {
  beforeEach(() => {
    depositTopicKnowledge.mockReset();
    acceptKnowledgePoint.mockReset();
    dismissKnowledgePoint.mockReset();
    appendPointsToRole.mockReset();
    openAssistant.mockReset();
  });

  it('「让助手整理」opens the assistant seeded with this chat\'s context', async () => {
    renderSection([pt({ id: '1', suggestedRoleId: 'svc' })]);
    await userEvent.click(screen.getByRole('button', { name: '✨ 让助手整理' }));
    expect(openAssistant).toHaveBeenCalledTimes(1);
    const seed = String(openAssistant.mock.calls[0]![0]);
    expect(seed).toContain('s1'); // hostSessionId
    expect(seed).toContain('服务容灾专家');
  });

  function renderSection(points: ChatKnowledgePoint[]) {
    render(
      <KnowledgePointsSection
        hostSessionId="s1" points={points} roles={ROLES} onMutated={vi.fn()}
      />,
    );
  }

  it('shows a topic only once even with multiple points under it', async () => {
    renderSection([
      pt({ id: '1', suggestedRoleId: 'svc' }),
      pt({ id: '2', suggestedRoleId: 'svc' }),
    ]);
    // One group header naming the topic + count, not two separate "服务容灾专家".
    expect(screen.getAllByText(/服务容灾专家/)).toHaveLength(1);
    expect(screen.getByText(/2 条/)).toBeInTheDocument();
    // Points are collapsed by default; expand the group to list them.
    await userEvent.click(screen.getByRole('button', { name: /服务容灾专家/ }));
    expect(screen.getByText('t-1')).toBeInTheDocument();
    expect(screen.getByText('t-2')).toBeInTheDocument();
  });

  it('collapses the topic points by default and reveals them on click', async () => {
    renderSection([pt({ id: '1', suggestedRoleId: 'svc' })]);
    // Collapsed: the group header shows, but the point title does not.
    expect(screen.queryByText('t-1')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /服务容灾专家/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('t-1')).toBeInTheDocument();
  });

  it('one-click 沉淀全部 deposits the whole topic via the API', async () => {
    depositTopicKnowledge.mockResolvedValue({
      roleId: 'svc', topicName: '服务容灾专家', found: 5, deposited: 5, conflicts: [], cleared: 2,
    });
    renderSection([
      pt({ id: '1', suggestedRoleId: 'svc' }),
      pt({ id: '2', suggestedRoleId: 'svc' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /沉淀全部到此 topic/ }));
    expect(depositTopicKnowledge).toHaveBeenCalledWith('s1', { targetRoleId: 'svc' });
  });

  it('deposits a new-topic suggestion by name', async () => {
    depositTopicKnowledge.mockResolvedValue({
      roleId: 'constants', topicName: 'CONSTANTS', found: 1, deposited: 1, conflicts: [], cleared: 1,
    });
    renderSection([pt({ id: '9', suggestedTopicName: 'CONSTANTS' })]);
    await userEvent.click(screen.getByRole('button', { name: /沉淀全部到此 topic/ }));
    expect(depositTopicKnowledge).toHaveBeenCalledWith('s1', { newTopicName: 'CONSTANTS' });
  });

  it('on a near-duplicate (409), offers 仍然采纳 instead of dead-ending, then force-accepts', async () => {
    acceptKnowledgePoint
      .mockRejectedValueOnce(new MockApiError(409, 'dup', { error: 'conflicts' }))
      .mockResolvedValueOnce({ pointId: '1', status: 'accepted', roleId: 'svc' });
    renderSection([pt({ id: '1', suggestedRoleId: 'svc' })]);

    await userEvent.click(screen.getByRole('button', { name: /服务容灾专家/ }));
    await userEvent.click(screen.getByRole('button', { name: /采纳/ }));
    // Inline conflict prompt appears (no dead-end error).
    expect(await screen.findByText(/该 topic 里已有近似的知识/)).toBeInTheDocument();
    expect(acceptKnowledgePoint).toHaveBeenLastCalledWith('1', { targetRoleId: 'svc' });

    await userEvent.click(screen.getByRole('button', { name: '仍然采纳' }));
    // Retries with force, preserving the original target.
    expect(acceptKnowledgePoint).toHaveBeenLastCalledWith('1', { targetRoleId: 'svc', force: true });
  });

  it('on a near-duplicate, 忽略 dismisses the point', async () => {
    acceptKnowledgePoint.mockRejectedValueOnce(new MockApiError(409, 'dup', { error: 'conflicts' }));
    dismissKnowledgePoint.mockResolvedValue({ pointId: '1', status: 'dismissed' });
    renderSection([pt({ id: '1', suggestedRoleId: 'svc' })]);

    await userEvent.click(screen.getByRole('button', { name: /服务容灾专家/ }));
    await userEvent.click(screen.getByRole('button', { name: /采纳/ }));
    await userEvent.click(await screen.findByRole('button', { name: '忽略' }));
    expect(dismissKnowledgePoint).toHaveBeenCalledWith('1');
  });

  it('surfaces deposit conflicts for confirmation (with the similar knowledge), then writes the chosen', async () => {
    depositTopicKnowledge.mockResolvedValue({
      roleId: 'svc', topicName: '服务容灾专家', found: 2, deposited: 1, cleared: 0,
      conflicts: [{
        title: 'SSR 超时常量', body: 'SSR 800ms…', kind: 'runbook',
        similarTo: { title: 'goofy SSR 超时', snippet: '…', similarity: 0.93 },
      }],
    });
    appendPointsToRole.mockResolvedValue({ roleId: 'svc', added: 1 });
    renderSection([pt({ id: '1', suggestedRoleId: 'svc' })]);

    await userEvent.click(screen.getByRole('button', { name: /沉淀全部到此 topic/ }));
    // Conflict surfaced (not silently dropped) with the similar existing knowledge + %.
    expect(await screen.findByText(/1 条与已有知识相似/)).toBeInTheDocument();
    expect(screen.getByText(/已有「goofy SSR 超时」（93% 相似）/)).toBeInTheDocument();

    // Nothing forced until the user picks one + confirms.
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /仍然写入选中/ }));
    expect(appendPointsToRole).toHaveBeenCalledWith('svc', [
      { title: 'SSR 超时常量', body: 'SSR 800ms…', kind: 'runbook' },
    ]);
  });
});
