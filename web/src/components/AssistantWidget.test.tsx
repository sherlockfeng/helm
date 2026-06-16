import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantWidget } from './AssistantWidget.js';
import { openAssistant } from './assistant-bus.js';

// Fake a streaming text/plain Response (what /api/agent-chat returns).
function streamResponse(chunks: string[]): Response {
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: enc.encode(chunks[i++]!) } : { done: true, value: undefined },
      }),
    },
    text: async () => chunks.join(''),
  } as unknown as Response;
}

describe('AssistantWidget', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('FAB toggles the chat panel', async () => {
    render(<AssistantWidget />);
    expect(screen.queryByRole('dialog', { name: 'helm 助手' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '打开 helm 助手' }));
    expect(screen.getByRole('dialog', { name: 'helm 助手' })).toBeInTheDocument();
  });

  it('sends a message and renders the streamed reply token-by-token', async () => {
    const fetchMock = vi.fn(async () => streamResponse(['整理', '完成', '✓']));
    vi.stubGlobal('fetch', fetchMock);

    render(<AssistantWidget />);
    await userEvent.click(screen.getByRole('button', { name: '打开 helm 助手' }));
    await userEvent.type(screen.getByPlaceholderText(/⌘\/Ctrl\+Enter/), '帮我整理');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    // POSTs the conversation to the agent-chat endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/agent-chat$/);
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '帮我整理' });

    // The streamed assistant reply accumulates into one bubble.
    expect(await screen.findByText('整理完成✓')).toBeInTheDocument();
  });

  it('openAssistant(seed) opens the panel and sends the seed as the first turn', async () => {
    const fetchMock = vi.fn(async () => streamResponse(['好的，', '我来看看']));
    vi.stubGlobal('fetch', fetchMock);

    const { act } = await import('react');
    render(<AssistantWidget />);
    // Triggered from elsewhere (e.g. a topic card button).
    await act(async () => { openAssistant('帮我整理「服务容灾专家」'); });

    expect(screen.getByRole('dialog', { name: 'helm 助手' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '帮我整理「服务容灾专家」' });
    expect(await screen.findByText('好的，我来看看')).toBeInTheDocument();
  });

  it('surfaces a backend error (e.g. no engine) without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503,
      text: async () => JSON.stringify({ error: 'no_engine', message: '需要配置引擎' }),
    } as unknown as Response)));

    render(<AssistantWidget />);
    await userEvent.click(screen.getByRole('button', { name: '打开 helm 助手' }));
    await userEvent.type(screen.getByPlaceholderText(/⌘\/Ctrl\+Enter/), 'hi');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(/需要配置引擎/)).toBeInTheDocument();
  });
});
