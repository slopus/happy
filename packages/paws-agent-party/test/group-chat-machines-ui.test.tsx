// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GroupChatApp } from '../src/web/GroupChatApp.js';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('shows readable machine metadata but submits its stable machine id', async () => {
  sessionStorage.setItem('apToken', 'test-token');
  const posted: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/api/paws/status')) return Response.json({ state: 'ready' });
    if (path.endsWith('/directories')) return Response.json({ success: true, path: '/home/node', parent: '/home', directories: [] });
    if (path.endsWith('/api/paws/machines')) return Response.json({ machines: [{ id: 'opaque-machine-uuid', active: true, metadata: { host: 'jackyMac-mini.local' } }] });
    if (path.endsWith('/api/group-chat/agents')) return Response.json({ agents: [{ id: 'a', name: '研究员', instructions: '分析问题', model: 'gpt-5.6-luna', effort: 'low', engine: 'codex' }] });
    if (path.endsWith('/api/group-chat/rooms') && init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return Response.json({}); }
    if (path.endsWith('/api/group-chat/rooms')) return Response.json({ rooms: [] });
    return Response.json({});
  }));
  render(<GroupChatApp/>);
  await screen.findByText('从一个群聊开始');
  fireEvent.click(screen.getAllByRole('button', { name: '新建群聊' })[0]!);
  const option = await screen.findByRole('option', { name: 'jackyMac-mini.local · 在线' });
  expect((option as HTMLOptionElement).value).toBe('opaque-machine-uuid');
  fireEvent.change(screen.getByLabelText('远端机器'), { target: { value: 'opaque-machine-uuid' } });
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  fireEvent.click(await screen.findByRole('button', { name: '选择当前目录' }));
  fireEvent.change(screen.getByLabelText('远端机器'), { target: { value: '' } });
  expect(screen.queryByText('/home/node')).toBeNull();
  expect((screen.getByRole('button', { name: '创建群聊' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('远端机器'), { target: { value: 'opaque-machine-uuid' } });
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  fireEvent.click(await screen.findByRole('button', { name: '选择当前目录' }));
  fireEvent.click(screen.getByRole('button', { name: '创建群聊' }));
  await vi.waitFor(() => expect(posted).toEqual([expect.objectContaining({ machineId: 'opaque-machine-uuid', directory: '/home/node', memberIds: ['a'] })]));
});
