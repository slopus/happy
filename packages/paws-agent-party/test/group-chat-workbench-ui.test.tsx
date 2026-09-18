// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GroupChatApp, MessageCard } from '../src/web/GroupChatApp.js';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('shows the author model and real message timestamp in the public timeline', () => {
  const snapshot = { members: [{ id: 'a', name: '研究员', engine: 'codex', model: 'gpt-5.6-luna' }], turns: [] } as never;
  const ts = Date.parse('2026-09-18T09:42:00Z');
  const { container } = render(<MessageCard room={snapshot} message={{ id: 'm', from: 'a', text: '公开结论', ts }}/>);
  expect(screen.getByText('研究员')).toBeTruthy();
  expect(screen.getByText('gpt-5.6-luna')).toBeTruthy();
  expect(container.querySelector('time')?.dateTime).toBe(new Date(ts).toISOString());
});

it('opens a named agent dialog and restores focus after Escape', async () => {
  sessionStorage.setItem('apToken', 'token');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/api/paws/status')) return Response.json({ state: 'ready' });
    if (path.endsWith('/api/paws/machines')) return Response.json({ machines: [] });
    if (path.endsWith('/api/group-chat/agents')) return Response.json({ agents: [] });
    return Response.json({ rooms: [] });
  }));
  render(<GroupChatApp/>);
  const trigger = await screen.findByRole('button', { name: /Agent 管理/ });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '管理 Agent' });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(screen.getByLabelText('Agent 名称')).toBeTruthy();
  expect(screen.getByLabelText('角色与关注点')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
