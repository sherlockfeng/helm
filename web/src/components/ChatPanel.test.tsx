import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPanel } from './ChatPanel.js';
import type { ChatMsg } from '../hooks/useAgentChat.js';

const MSGS: ChatMsg[] = [
  { role: 'assistant', content: '我是 helm 助手' },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好，需要什么帮助？' },
];

describe('ChatPanel', () => {
  it('renders the messages as bubbles', () => {
    render(<ChatPanel messages={MSGS} busy={false} error={null} onSend={vi.fn()} />);
    expect(screen.getByText('我是 helm 助手')).toBeInTheDocument();
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText('你好，需要什么帮助？')).toBeInTheDocument();
  });

  it('sends on click and on Cmd/Ctrl+Enter, with the typed text', async () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={MSGS} busy={false} error={null} onSend={onSend} />);
    const ta = screen.getByPlaceholderText(/⌘\/Ctrl\+Enter/);
    await userEvent.type(ta, '帮我整理知识');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('帮我整理知识');

    await userEvent.type(ta, '再来一条');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onSend).toHaveBeenLastCalledWith('再来一条');
  });

  it('disables input + send while busy and shows a thinking placeholder', () => {
    render(
      <ChatPanel
        messages={[{ role: 'user', content: 'hi' }, { role: 'assistant', content: '' }]}
        busy error={null} onSend={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText(/⌘\/Ctrl\+Enter/)).toBeDisabled();
    expect(screen.getByText('思考中…')).toBeInTheDocument();
  });

  it('renders assistant markdown (bold / inline code) as elements, user text literal', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          { role: 'assistant', content: 'dr-platform 是 **对话**，调用 `list_roles`' },
          { role: 'user', content: '**保持原样**' },
        ]}
        busy={false} error={null} onSend={vi.fn()}
      />,
    );
    expect(container.querySelector('.helm-chat-md strong')?.textContent).toBe('对话');
    expect(container.querySelector('.helm-chat-md code')?.textContent).toBe('list_roles');
    // The user bubble keeps the literal asterisks (not parsed).
    expect(screen.getByText('**保持原样**')).toBeInTheDocument();
  });

  it('shows an error line', () => {
    render(<ChatPanel messages={MSGS} busy={false} error="引擎未配置" onSend={vi.fn()} />);
    expect(screen.getByText(/引擎未配置/)).toBeInTheDocument();
  });
});
