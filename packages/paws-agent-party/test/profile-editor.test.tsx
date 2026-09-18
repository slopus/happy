// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProfileEditor } from '../src/web/ProfileEditor.js';
import { createApi } from '../src/web/api.js';
afterEach(cleanup);
it('submits the selected robot and readable device using stable IDs without an avatar upload', async () => {
  let saved: unknown;
  const api = createApi(() => 'token', () => {}, async () => Response.json({ available: false, reason: 'no session' }), '');
  render(<ProfileEditor api={api} machines={[{ id: 'opaque', metadata: { host: 'jackyMac-mini.local' }, active: true } as never]} sessions={[]} onSave={async value => { saved = value; }}/>);
  fireEvent.change(screen.getByLabelText('Agent 名称'), { target: { value: '研究员' } });
  fireEvent.change(screen.getByLabelText('角色与关注点'), { target: { value: '查证资料' } });
  fireEvent.change(screen.getByLabelText('执行设备'), { target: { value: 'opaque' } });
  fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/work' } });
  fireEvent.click(screen.getByRole('button', { name: '选择机器人' }));
  expect(screen.getAllByRole('button', { name: /机器人头像 \d/ })).toHaveLength(24);
  fireEvent.click(screen.getByRole('button', { name: '机器人头像 24' }));
  expect(document.querySelector('input[type=file]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }));
  await vi.waitFor(() => expect(saved).toMatchObject({ name: '研究员', instructions: '查证资料', avatarId: 23, machineId: 'opaque', directory: '/work', model: 'gpt-5.6-luna', effort: 'low' }));
});

it('ignores stale directory responses after machine changes and newer navigation', async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const api = vi.fn((path: string, init?: RequestInit) => new Promise(resolve => {
    init?.signal?.addEventListener('abort', () => resolve({ success: false, error: 'aborted' }), { once: true });
    pending.set(path, resolve);
  }));
  render(<ProfileEditor api={api as never} machines={[{ id: 'a', active: true }, { id: 'b', active: true }] as never} sessions={[]} onSave={async () => {}}/>);
  fireEvent.change(screen.getByLabelText('执行设备'), { target: { value: 'a' } });
  fireEvent.click(screen.getByRole('button', { name: '浏览远端目录' }));
  await vi.waitFor(() => expect([...pending.keys()].some(path => path.includes('/a/directories'))).toBe(true));
  fireEvent.change(screen.getByLabelText('执行设备'), { target: { value: 'b' } });
  pending.get([...pending.keys()].find(path => path.includes('/a/directories'))!)?.({ success: true, path: '/a/project', parent: '/a', home: '/a', directories: [] });
  expect(screen.queryByText('/a/project')).toBeNull();
  await vi.waitFor(() => expect((screen.getByRole('button', { name: '浏览远端目录' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '浏览远端目录' }));
  const rootB = [...pending.keys()].find(path => path.includes('/b/directories'))!;
  pending.get(rootB)?.({ success: true, path: '/b', parent: null, home: '/b', directories: [{ name: 'old', path: '/b/old', isProjectRoot: false }, { name: 'new', path: '/b/new', isProjectRoot: false }] });
  expect(await screen.findByRole('button', { name: '▸ old' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '▸ old' }));
  fireEvent.click(screen.getByRole('button', { name: '▸ new' }));
  const old = [...pending.keys()].find(path => path.includes(encodeURIComponent('/b/old')))!;
  const newer = [...pending.keys()].find(path => path.includes(encodeURIComponent('/b/new')))!;
  pending.get(newer)?.({ success: true, path: '/b/new', parent: '/b', home: '/b', directories: [] });
  expect(await screen.findByText('/b/new')).toBeTruthy();
  pending.get(old)?.({ success: true, path: '/b/old', parent: '/b', home: '/b', directories: [] });
  expect(screen.queryByText('/b/old')).toBeNull();
});
