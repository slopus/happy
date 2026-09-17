// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chat, type ChatProps } from '../vendor/agents-party/src/ui/party/chat.js';
import { initialTimeline, ownSend, receivedBatch, type TimelineMessage } from '../src/timeline.js';

beforeAll(() => {
  // DOM platform geometry for the real upstream virtualizer (no UI mocks).
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  HTMLElement.prototype.scrollTo = () => {};
});
afterEach(cleanup);

const base: ChatProps = {
  parties: [], activeId: 'party-1', onOpenParty() {}, title: '会诊',
  participants: [{ name: 'trend30', color: 'blue', joinedAt: 1 }], messages: [],
  onSend: async () => {}, recipients: { options: [{ name: 'trend30', color: 'blue' }], selected: [], onToggle() {}, onEveryone() {} },
};

describe('original Party Chat extensions', () => {
  it('opens participant execution details while recipient chips independently address messages', () => {
    function Harness() {
      const [detail, setDetail] = useState('');
      const [selected, setSelected] = useState<string[]>([]);
      return <><Chat {...base} onOpenParticipant={setDetail} recipients={{ ...base.recipients, selected, onToggle: name => setSelected([name]) }} />
        <output aria-label="收件人">{selected.join(',')}</output>
        {detail && <div role="dialog" aria-label="执行详情">{detail} 远端可能继续</div>}</>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /查看.*trend30/ }));
    expect(screen.getByRole('dialog', { name: '执行详情' }).textContent).toContain('远端可能继续');
    expect(screen.getByLabelText('收件人').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'trend30' }));
    expect(screen.getByLabelText('收件人').textContent).toBe('trend30');
  });

  it('allows an image-only send through the original composer', async () => {
    const sent: string[] = [];
    render(<Chat {...base} composerHasContent onSend={async text => { sent.push(text); }} />);
    const button = screen.getByRole('button', { name: /发送消息|Send message/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() => expect(sent).toEqual(['']));
  });

  it('renders an unseen received message after an own send without advancing the receive cursor', async () => {
    const message = (seq: number): TimelineMessage => ({ id: `p-${seq}`, cursor: String(seq), kind: 'message', from: 'trend30', to: '*', ts: seq, text: `公开消息 ${seq}` });
    function Harness() {
      const [timeline, setTimeline] = useState(receivedBatch(initialTimeline(), [message(1)]));
      return <><Chat {...base} messages={timeline.messages} onSend={async () => { setTimeline(state => ownSend(state, message(3))); }} />
        <output aria-label="接收游标">{timeline.receiveCursor}</output>
        <button onClick={() => setTimeline(state => receivedBatch(state, [message(2), message(3)]))}>接收批次</button></>;
    }
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'own send' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await screen.findByText('公开消息 3');
    expect(screen.getByLabelText('接收游标').textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: '接收批次' }));
    expect(await screen.findByText('公开消息 2')).toBeTruthy();
    expect(screen.getAllByText('公开消息 3')).toHaveLength(1);
  });

  it('keeps a failed draft and exposes a retryable error', async () => {
    render(<Chat {...base} onSend={async () => { throw new Error('连接失败'); }} />);
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '保留这条追问' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect((await screen.findByRole('alert')).textContent).toBe('连接失败');
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('保留这条追问');
  });
});
