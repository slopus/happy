// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { GroupChatApp, MessageCard } from '../src/web/GroupChatApp.js';
import { reconcileRoomList } from '../src/web/group-stream.js';

vi.mock('../src/web/lib/crypto.js', () => ({ decrypt: async (_key: string, text: string) => text }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('reconciles full room lists authoritatively while preserving newer surviving snapshots', () => {
  const old = fixture('old') as never; const survivor = { ...fixture('keep'), updatedAt: 10 } as never;
  const incoming = { ...fixture('keep'), updatedAt: 5, title: 'stale' } as never;
  expect(reconcileRoomList([old, survivor], [incoming]).map(room => room.id)).toEqual(['keep']);
  expect(reconcileRoomList([old, survivor], [incoming])[0]?.updatedAt).toBe(10);
});

function fixture(id = 'one') {
  return { id, partyId: id, title: `Room ${id}`, members: [{ id: 'a', name: '研究员', engine: 'codex', model: 'luna', status: 'running' }], turns: [], createdAt: 1, updatedAt: 1, maxRounds: 10, autoDebate: true };
}

it('shows honest waiting and preserves failed partial output with its reason', () => {
  const message = { id: 'task', taskMessageId: 'task', from: 'a', text: '', ts: 1, live: { text: '', status: 'running' as const, createdAt: 1 } };
  const { rerender } = render(<MessageCard room={fixture() as never} message={message}/>);
  expect(screen.getByText('等待 Agent 输出…')).toBeTruthy();
  expect(screen.getByText('正在回复')).toBeTruthy();
  rerender(<MessageCard room={fixture() as never} message={{ ...message, text: '已生成的一段', live: { ...message.live, text: '已生成的一段', status: 'failed', error: '连接中断' } }}/>);
  expect(screen.getByText('已生成的一段')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('失败：连接中断');
  expect(screen.queryByText('正在回复')).toBeNull();
});

it('updates a single live card, keeps completed text until durable history arrives, and rejects stale room polling', async () => {
  sessionStorage.setItem('apToken', 'secret');
  const snapshot = fixture();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let durable: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/events')) {
      expect(path).not.toContain('secret');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/status')) return Response.json({ state: 'disconnected' });
    if (path.endsWith('/agents')) return Response.json({ agents: [] });
    if (path.endsWith('/rooms')) return Response.json({ rooms: [snapshot] });
    if (path.includes('/messages')) return Response.json({ messages: durable });
    return Response.json({ key: 'key' });
  }));
  const { container } = render(<GroupChatApp/>);
  await vi.waitFor(() => expect(stream).toBeDefined());
  const publish = async (text: string, status = 'running', publicMessageId?: string) => {
    const next = { ...snapshot, updatedAt: Date.now(), turns: [{ participant: 'a', taskMessageId: 'task', publicMessageId, live: { text, status, createdAt: 2 } }] };
    await act(async () => { stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(next)}\n\n`)); });
  };
  await publish('第一段');
  expect(await screen.findByText('第一段')).toBeTruthy();
  expect(screen.getByText('正在回复')).toBeTruthy();
  const card = container.querySelector('.timeline-message');
  const timeline = screen.getByRole('region', { name: '群聊消息' });
  Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 300 });
  timeline.scrollTop = 700; fireEvent.scroll(timeline);
  await publish('第一段，第二段');
  expect(screen.getByText('第一段，第二段')).toBeTruthy();
  expect(timeline.scrollTop).toBe(1000);
  expect(container.querySelector('.timeline-message')).toBe(card);
  timeline.scrollTop = 10; fireEvent.scroll(timeline);
  await publish('完整回答', 'completed', 'final');
  expect(timeline.scrollTop).toBe(10);
  expect(screen.getByText('完整回答')).toBeTruthy();
  expect(screen.queryByText('正在回复')).toBeNull();
  durable = [{ id: 'final', from: 'a', to: '*', kind: 'message', text: '正式完整回答', ts: 2 }];
  expect(await screen.findByText('正式完整回答', {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.queryByText('完整回答')).toBeNull();
  expect(container.querySelectorAll('.timeline-message')).toHaveLength(1);
  expect(container.querySelector('.timeline-message')).toBe(card);
});

it('aborts the old stream and ignores delayed history when switching rooms', async () => {
  sessionStorage.setItem('apToken', 'token');
  let oldSignal: AbortSignal | undefined;
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/events')) {
      if (path.includes('/one/')) oldSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/status')) return Response.json({ state: 'disconnected' });
    if (path.endsWith('/agents')) return Response.json({ agents: [] });
    if (path.endsWith('/rooms')) return Response.json({ rooms: [fixture(), fixture('two')] });
    if (path.includes('/one/messages')) return new Promise<Response>(resolve => { resolveOld = resolve; });
    if (path.includes('/two/messages')) return Response.json({ messages: [{ id: 'new', from: 'host', to: '*', kind: 'message', text: '新群消息', ts: 2 }] });
    return Response.json({ key: 'key' });
  }));
  render(<GroupChatApp/>);
  await vi.waitFor(() => expect(resolveOld).toBeDefined());
  fireEvent.click(within(screen.getByRole('navigation', { name: '我的群聊' })).getByRole('button', { name: /Room two 1 位/ }));
  expect(await screen.findByText('新群消息')).toBeTruthy();
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolveOld(Response.json({ messages: [{ id: 'old', from: 'host', to: '*', kind: 'message', text: '旧群消息', ts: 1 }] })));
  expect(screen.queryByText('旧群消息')).toBeNull();
  expect(screen.getByText('新群消息')).toBeTruthy();
});

it('still displays history when a request takes longer than the polling interval', async () => {
  vi.useFakeTimers();
  sessionStorage.setItem('apToken', 'token');
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (path.endsWith('/status')) return Response.json({ state: 'disconnected' });
    if (path.endsWith('/agents')) return Response.json({ agents: [] });
    if (path.endsWith('/rooms')) return Response.json({ rooms: [fixture()] });
    if (path.includes('/messages')) return new Promise<Response>(resolve => pending.push(resolve));
    return Response.json({ key: 'key' });
  }));
  render(<GroupChatApp/>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1700); });
  expect(pending.length).toBeGreaterThan(1);
  await act(async () => pending[0](Response.json({ messages: [{ id: 'slow', from: 'host', to: '*', kind: 'message', text: '慢请求的消息', ts: 1 }] })));
  expect(screen.getByText('慢请求的消息')).toBeTruthy();
});
