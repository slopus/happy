// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { StartConsultation } from '../src/web/Consultation.js';
import { AgentDetails } from '../src/web/AgentDetails.js';
import { createApi } from '../src/web/api.js';
import type { RunSnapshot } from '../src/contracts.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const api = createApi(() => 'test', () => {}, async () => Response.json({ messages: [], requests: [], hasMore: false }));
const run = { id: 'r', roles: { moderator: { status: 'completed' } }, turns: [] } as unknown as RunSnapshot;
function viewport(narrow: boolean) { window.matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList; }
function Surfaces({ details = false }: { details?: boolean }) {
  const [start, setStart] = useState(false); const [showDetails, setDetails] = useState(false);
  return <><button onClick={() => details ? setDetails(true) : setStart(true)}>打开</button>
    {showDetails && <AgentDetails run={run} role="moderator" api={api} onClose={() => setDetails(false)} />}
    <button onClick={() => setStart(true)}>叠加创建</button>
    {start && <StartConsultation ready={false} machines={[]} api={api} onStarted={() => {}} onClose={() => setStart(false)} />}
    <button>外部按钮</button></>;
}

it('focuses, contains Tab, closes on Escape and restores creation focus', async () => {
  viewport(false); render(<Surfaces />); const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: '打开' }); await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '新建会诊' }); const close = within(dialog).getByRole('button', { name: '关闭' });
  expect(document.activeElement).toBe(close);
  await user.tab({ shift: true }); expect(dialog.contains(document.activeElement)).toBe(true); expect(document.activeElement).not.toBe(close);
  await user.tab(); expect(document.activeElement).toBe(close);
  screen.getByRole('button', { name: '外部按钮' }).focus(); expect(dialog.contains(document.activeElement)).toBe(true);
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
});

it('contains narrow details and only the top overlapping modal handles Escape and restoration', async () => {
  viewport(true); render(<Surfaces details />); const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: '打开' }); await user.click(trigger);
  const details = screen.getByRole('dialog', { name: '执行详情' }); expect(details.getAttribute('aria-modal')).toBe('true');
  const close = within(details).getByRole('button', { name: '关闭详情' }); expect(document.activeElement).toBe(close);
  await screen.findByRole('button', { name: '刷新记录' }); await user.tab({ shift: true }); expect(document.activeElement).toBe(screen.getByRole('button', { name: '刷新记录' }));
  await user.tab(); expect(document.activeElement).toBe(close);
  fireEvent.click(screen.getByRole('button', { name: '叠加创建' }));
  expect(within(screen.getByRole('dialog', { name: '新建会诊' })).getByRole('button', { name: '关闭' })).toBe(document.activeElement);
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog', { name: '新建会诊' })).toBeNull(); expect(document.activeElement).toBe(close);
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
});

it('keeps wide details nonmodal with ordinary tab navigation', async () => {
  viewport(false); render(<Surfaces details />); const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '打开' }));
  const details = screen.getByRole('dialog', { name: '执行详情' }); expect(details.getAttribute('aria-modal')).not.toBe('true');
  const refresh = await screen.findByRole('button', { name: '刷新记录' }); refresh.focus(); await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '叠加创建' }));
  await user.keyboard('{Escape}'); expect(screen.getByRole('dialog', { name: '执行详情' })).toBeTruthy();
});
