import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the API client + toast so the component renders without a backend.
const depositTopicKnowledge = vi.fn();
vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error {},
  helmApi: {
    depositTopicKnowledge: (...args: unknown[]) => depositTopicKnowledge(...args),
    extractKnowledge: vi.fn(),
    acceptKnowledgePoint: vi.fn(),
    dismissKnowledgePoint: vi.fn(),
  },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { KnowledgePointsSection, groupPointsByTopic } from './Chats.js';
import type { ChatKnowledgePoint } from '../api/types.js';

function pt(over: Partial<ChatKnowledgePoint> & { id: string }): ChatKnowledgePoint {
  return {
    hostSessionId: 's1', title: `t-${over.id}`, body: 'b', kind: 'spec',
    suggestedRoleId: null, suggestedTopicName: null, status: 'pending',
    createdAt: '2026-01-01T00:00:00Z', ...over,
  } as ChatKnowledgePoint;
}

const ROLES = [{ id: 'svc', name: '服务容灾专家' }, { id: 'goofy', name: 'goofy_ssr' }];

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
  beforeEach(() => { depositTopicKnowledge.mockReset(); });

  function renderSection(points: ChatKnowledgePoint[]) {
    render(
      <KnowledgePointsSection
        hostSessionId="s1" points={points} roles={ROLES} onMutated={vi.fn()}
      />,
    );
  }

  it('shows a topic only once even with multiple points under it', () => {
    renderSection([
      pt({ id: '1', suggestedRoleId: 'svc' }),
      pt({ id: '2', suggestedRoleId: 'svc' }),
    ]);
    // One group header naming the topic + count, not two separate "服务容灾专家".
    expect(screen.getAllByText(/服务容灾专家/)).toHaveLength(1);
    expect(screen.getByText(/2 条/)).toBeInTheDocument();
    // Both points still listed under it.
    expect(screen.getByText('t-1')).toBeInTheDocument();
    expect(screen.getByText('t-2')).toBeInTheDocument();
  });

  it('one-click 沉淀全部 deposits the whole topic via the API', async () => {
    depositTopicKnowledge.mockResolvedValue({
      roleId: 'svc', topicName: '服务容灾专家', found: 5, deposited: 5, skipped: 0, cleared: 2,
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
      roleId: 'constants', topicName: 'CONSTANTS', found: 1, deposited: 1, skipped: 0, cleared: 1,
    });
    renderSection([pt({ id: '9', suggestedTopicName: 'CONSTANTS' })]);
    await userEvent.click(screen.getByRole('button', { name: /沉淀全部到此 topic/ }));
    expect(depositTopicKnowledge).toHaveBeenCalledWith('s1', { newTopicName: 'CONSTANTS' });
  });
});
