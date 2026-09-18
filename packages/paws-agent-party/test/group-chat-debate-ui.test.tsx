// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GroupChatApp, MessageCard } from '../src/web/GroupChatApp.js';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

function room(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1', partyId: 'party-1', title: '是否远程办公', machineId: 'machine-1', directory: '/tmp/work', autoReply: true,
    autoDebate: true, maxRounds: 10, createdAt: 1, updatedAt: 1,
    members: [
      { id: 'a', name: '正方', instructions: '支持远程办公。', engine: 'codex', status: 'completed' },
      { id: 'b', name: '反方', instructions: '质疑远程办公。', engine: 'codex', status: 'running' },
    ],
    turns: [],
    debate: { id: 'debate-1', status: 'running', members: ['a', 'b'], maxRounds: 10, completedRounds: 2, completedTurns: 4, currentTurn: 5, nextMemberId: 'a', sourceMessageId: 'source-1' },
    ...overrides,
  };
}

it('shows bounded debate progress, locks its cap while running, and sends the dedicated stop request', async () => {
  sessionStorage.setItem('apToken', 'test-token');
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const snapshot = room();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, init });
    if (path.endsWith('/api/paws/status')) return Response.json({ state: 'ready', serverUrl: 'http://paws.test' });
    if (path.endsWith('/api/paws/machines')) return Response.json({ machines: [] });
    if (path.endsWith('/api/group-chat/agents')) return Response.json({ agents: [] });
    if (path.endsWith('/api/group-chat/rooms')) return Response.json({ rooms: [snapshot] });
    if (path.endsWith('/api/parties/party-1')) return Response.json({ key: 'test-key' });
    if (path.includes('/api/parties/party-1/messages')) return Response.json({ messages: [] });
    if (path.endsWith('/api/group-chat/rooms/room-1/debate/stop')) return Response.json({ ...snapshot, debate: { ...snapshot.debate, status: 'stopped', nextMemberId: null } });
    return Response.json({});
  }));

  render(<GroupChatApp />);
  // The room becomes selected after the three initial API responses settle;
  // leave headroom for parallel worker CPU without relaxing the interaction.
  expect(await screen.findByText('自动辩论', {}, { timeout: 5_000 })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('进行中 · 第 3 / 10 轮 · 下一位：正方');
  expect((screen.getByLabelText('最大辩论轮数') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '停止辩论' }));
  await vi.waitFor(() => expect(calls.some(call => call.path.endsWith('/api/group-chat/rooms/room-1/debate/stop') && call.init?.method === 'POST' && call.init?.body === '{}')).toBe(true));
});

it('allows a non-running room to set its bounded 1–10 round cap', async () => {
  sessionStorage.setItem('apToken', 'test-token');
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let snapshot = room({ autoDebate: true, debate: undefined });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, init });
    if (path.endsWith('/api/paws/status')) return Response.json({ state: 'disconnected' });
    if (path.endsWith('/api/group-chat/agents')) return Response.json({ agents: [] });
    if (path.endsWith('/api/group-chat/rooms')) {
      if (init?.method === 'PATCH') snapshot = { ...snapshot, ...JSON.parse(String(init.body)) };
      return Response.json(init?.method === 'PATCH' ? snapshot : { rooms: [snapshot] });
    }
    if (path.endsWith('/api/parties/party-1')) return Response.json({ key: 'test-key' });
    if (path.includes('/api/parties/party-1/messages')) return Response.json({ messages: [] });
    return Response.json({});
  }));

  render(<GroupChatApp />);
  const selector = await screen.findByLabelText('最大辩论轮数');
  fireEvent.change(selector, { target: { value: '4' } });
  await vi.waitFor(() => expect(calls.some(call => call.path.endsWith('/api/group-chat/rooms/room-1') && call.init?.method === 'PATCH' && call.init?.body === JSON.stringify({ maxRounds: 4 }))).toBe(true));
});

it('shows a manually stopped member as a neutral Chinese state, not a failure', async () => {
  sessionStorage.setItem('apToken', 'test-token');
  const snapshot = room({
    members: [
      { id: 'a', name: '正方', instructions: '支持远程办公。', engine: 'codex', status: 'stopped', error: 'Debate stopped' },
      { id: 'b', name: '反方', instructions: '质疑远程办公。', engine: 'codex', status: 'idle' },
    ],
    debate: { id: 'debate-1', status: 'stopped', members: ['a', 'b'], maxRounds: 10, completedRounds: 2, completedTurns: 4, currentTurn: 5, nextMemberId: null, sourceMessageId: 'source-1' },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/api/paws/status')) return Response.json({ state: 'ready', serverUrl: 'http://paws.test' });
    if (path.endsWith('/api/paws/machines')) return Response.json({ machines: [] });
    if (path.endsWith('/api/group-chat/agents')) return Response.json({ agents: [] });
    if (path.endsWith('/api/group-chat/rooms')) return Response.json({ rooms: [snapshot] });
    if (path.endsWith('/api/parties/party-1')) return Response.json({ key: 'test-key' });
    if (path.includes('/api/parties/party-1/messages')) return Response.json({ messages: [] });
    return Response.json({});
  }));

  render(<GroupChatApp />);
  const membersButton = await screen.findByRole('button', { name: /成员 · 2/ });
  fireEvent.click(membersButton);
  expect(membersButton.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByText('已停止')).toBeTruthy();
  expect(screen.queryByText('Debate stopped')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('labels persisted debate messages with their opening or rebuttal round', () => {
  const snapshot = room({
    turns: [
      { publicMessageId: 'opening-message', phase: 'opening', round: 1 },
      { publicMessageId: 'rebuttal-message', phase: 'rebuttal', round: 2 },
    ],
  }) as never;
  const { rerender } = render(<MessageCard room={snapshot} message={{ id: 'opening-message', from: 'a', text: '我的立场是…', ts: 1 } as never} />);
  expect(screen.getByText('立论')).toBeTruthy();

  rerender(<MessageCard room={snapshot} message={{ id: 'rebuttal-message', from: 'b', text: '我的反驳是…', ts: 2 } as never} />);
  expect(screen.getByText('交锋 2')).toBeTruthy();
});
