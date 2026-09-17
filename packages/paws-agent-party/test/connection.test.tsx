// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConnectionPanel } from '../src/web/ConnectionPanel.js';
import type { ConnectionStatus } from '../src/contracts.js';
import { userEvent } from '@testing-library/user-event';
import { RunStatus, StartConsultation } from '../src/web/Consultation.js';
import type { RunSnapshot } from '../src/contracts.js';
import type { Api } from '../src/web/api.js';
import { createApi } from '../src/web/api.js';
import type { StartInput } from '../src/contracts.js';
afterEach(cleanup);

it('cancels a held initial link while disconnected and ignores its late response during a newer link', async () => {
  let finishOld!: (status: ConnectionStatus) => void; let finishNew!: (status: ConnectionStatus) => void;
  let posts = 0;
  const api = (async (_path: string, init: RequestInit) => {
    if (init.method === 'DELETE') return { state: 'disconnected' };
    posts++;
    return new Promise<ConnectionStatus>(resolve => { if (posts === 1) finishOld = resolve; else finishNew = resolve; });
  }) as Api;
  function Panel() { const [status, setStatus] = useState<ConnectionStatus>({ state: 'disconnected' }); return <ConnectionPanel status={status} onChange={setStatus} active={false} api={api} />; }
  render(<Panel />);
  const link = screen.getByRole('button', { name: '二维码授权' }) as HTMLButtonElement;
  const cancel = screen.getByRole('button', { name: '断开连接' }) as HTMLButtonElement;
  fireEvent.click(link); expect(cancel.disabled).toBe(false);
  await act(async () => { fireEvent.click(cancel); }); expect(link.disabled).toBe(false);
  fireEvent.click(link);
  await act(async () => { finishOld({ state: 'linking', serverUrl: 'https://old.invalid' }); });
  expect(screen.queryByText(/old.invalid/)).toBeNull(); expect(link.disabled).toBe(true); expect(cancel.disabled).toBe(false);
  await act(async () => { finishNew({ state: 'ready', serverUrl: 'https://new.invalid' }); });
  expect(screen.getByText(/已连接.*new.invalid/)).toBeTruthy(); expect(link.disabled).toBe(false);
});

it('submits a recovery code only to the dedicated in-memory recovery endpoint', async () => {
  let request: { path: string; body: unknown } | null = null;
  const api = (async (path: string, init: RequestInit) => {
    request = { path, body: JSON.parse(String(init.body)) };
    return { state: 'ready', serverUrl: 'http://paws.test' };
  }) as Api;
  function Panel() { const [status, setStatus] = useState<ConnectionStatus>({ state: 'disconnected' }); return <ConnectionPanel status={status} onChange={setStatus} active={false} api={api} />; }
  render(<Panel />);
  fireEvent.change(screen.getByLabelText('Paws 恢复码'), { target: { value: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AA' } });
  await userEvent.click(screen.getByRole('button', { name: '使用恢复码连接' }));
  await vi.waitFor(() => expect(request).not.toBeNull());
  expect(request).toEqual({ path: '/api/paws/recover', body: { serverUrl: 'http://47.115.228.20:3005', recoveryCode: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AA' } });
  expect(screen.getByText(/已连接.*paws.test/)).toBeTruthy();
  expect((screen.getByLabelText('Paws 恢复码') as HTMLInputElement).value).toBe('');
});

it('blocks model submission while disconnected even with complete machine input', () => {
  render(<StartConsultation ready={false} machines={[]} api={(async () => ({})) as unknown as Api} onStarted={() => {}} onClose={() => {}} />);
  expect(screen.getByText(/先连接 Paws/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
});

it.each(['failed', 'stopped', 'interrupted'] as const)('does not label a %s run completed and exposes stop for active follow-ups', status => {
  const run = { id: 'r', status, phase: 'test', roles: {}, turns: [], followUps: [{ requestId: 'f', status: 'running', roles: { trend30: { status: 'running' } } }] } as unknown as RunSnapshot;
  let stopped = false;
  render(<RunStatus run={run} onStop={async () => { stopped = true; }} />);
  expect(screen.queryByText('已完成')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '停止协调' }));
  expect(stopped).toBe(true);
  expect(screen.getByText(/远端可能继续/)).toBeTruthy();
});

it.each([{ text: '文字问题', image: false }, { text: '', image: true }, { text: '图文问题', image: true }])('submits text/image input without losing attachments: $text $image', async ({ text, image }) => {
  let submitted: StartInput | null = null;
  URL.createObjectURL = () => 'blob:test-preview'; URL.revokeObjectURL = () => {};
  const api = createApi(() => 'test', () => {}, (async (path: string, init?: RequestInit) => {
    if (path === '/api/assets') return Response.json({ id: 'image-1', name: 'chart.png', mimeType: 'image/png', size: 5 });
    if (path.startsWith('/api/assets/')) return new Response(new Blob(['image']));
    submitted = JSON.parse(String(init?.body));
    return Response.json({ id: 'created' });
  }) as typeof fetch);
  render(<StartConsultation ready machines={[{ id: 'machine-1', active: true } as never]} api={api} onStarted={() => {}} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('标的'), { target: { value: 'TEST' } });
  fireEvent.change(screen.getByLabelText('机器'), { target: { value: 'machine-1' } });
  fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/explicit/project' } });
  if (image) { fireEvent.change(screen.getByLabelText('添加图片'), { target: { files: [new File(['image'], 'chart.png', { type: 'image/png' })] } }); await screen.findByRole('button', { name: '移除 chart.png' }); }
  if (text) fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: text } });
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await vi.waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted).toMatchObject({ text, machineId: 'machine-1', directory: '/explicit/project', mode: 'single', images: image ? [{ id: 'image-1' }] : [] });
});
