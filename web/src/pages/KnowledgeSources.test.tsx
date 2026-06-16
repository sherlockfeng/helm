import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { listCapturedUnpublished } = vi.hoisted(() => ({ listCapturedUnpublished: vi.fn() }));
vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error {},
  helmApi: { listCapturedUnpublished: (...a: unknown[]) => listCapturedUnpublished(...a), publishCaptured: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { CapturedPanel } from './KnowledgeSources.js';
import type { KnowledgeRepo } from '../api/types.js';

const repo = { id: 'r1', profile: 'llm-wiki' } as KnowledgeRepo;

/**
 * Regression: case files ride the publish MR (backend ships them as extraFiles),
 * so the panel must label them "case" and count them as publishable — NOT the
 * misleading "未入索引（将跳过）" that implied they'd be dropped.
 */
describe('CapturedPanel', () => {
  it('labels case files as case (publishable), only flags genuinely un-indexed', async () => {
    listCapturedUnpublished.mockResolvedValue({ files: [
      { relPath: 'chat-captured/u/x/1-id.md', isNew: true, pointId: 'p1', title: 'doc' },
      { relPath: 'chat-captured/u/x/cases/c1.md', isNew: true, isCase: true, title: 'c1' },
      { relPath: 'chat-captured/u/x/orphan.md', isNew: true },
    ] });
    render(<CapturedPanel repo={repo} busyParent={false} />);

    // The case file shows "· case", not "未入索引".
    expect(await screen.findByText('chat-captured/u/x/cases/c1.md')).toBeInTheDocument();
    const caseLi = screen.getByText('chat-captured/u/x/cases/c1.md').closest('li')!;
    expect(caseLi.textContent).toContain('case');
    expect(caseLi.textContent).not.toContain('未入索引');

    // Only the genuine orphan (no pointId, no isCase) is flagged skipped.
    const orphanLi = screen.getByText('chat-captured/u/x/orphan.md').closest('li')!;
    expect(orphanLi.textContent).toContain('未入索引');

    // 开 MR enabled (there are publishable files: the indexed point + the case).
    expect(screen.getByRole('button', { name: '开 MR' })).toBeEnabled();
  });

  it('disables 开 MR when nothing is publishable (all un-indexed, no cases)', async () => {
    listCapturedUnpublished.mockResolvedValue({ files: [
      { relPath: 'chat-captured/u/x/orphan.md', isNew: true },
    ] });
    render(<CapturedPanel repo={repo} busyParent={false} />);
    await screen.findByText('chat-captured/u/x/orphan.md');
    expect(screen.getByRole('button', { name: '开 MR' })).toBeDisabled();
  });
});
