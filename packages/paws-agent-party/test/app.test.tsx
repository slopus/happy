// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PartyApp } from '../src/web/PartyApp.js';
import { encryptText, generatePartyKey } from '../vendor/agents-party/src/core/crypto.js';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  HTMLElement.prototype.scrollTo = () => {};
  window.matchMedia = () => ({ matches: false }) as MediaQueryList;
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('shows an invalid manual token error instead of silently keeping the gate', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 })));
  render(<PartyApp />);
  fireEvent.change(screen.getByLabelText('服务访问令牌'), { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: '进入' }));
  expect(await screen.findByText(/令牌无效/)).toBeTruthy();
});

it('restores stored Party history and exact details on reload using the original Chat', async () => {
  const key = generatePartyKey();
  const party = { id: 'party-1', title: '恢复的会诊', createdAt: 1, lastMessageAt: 1, messagesCount: 1, key };
  const run = { id: 'run-1', partyId: party.id, stock: 'TEST', mode: 'single', status: 'stopped', phase: 'stopped', createdAt: 1,
    roles: { trend30: { role: 'trend30', sessionId: 'exact-session', status: 'stopped' } }, followUps: [], turns: [
      { runId: 'run-1', partyId: party.id, participant: 'trend30', taskMessageId: 'task-original', publicMessageId: 'public-original', sessionId: 'exact-session', rootTurnId: 'root-original', sourceMessageId: 'source-original', localId: 'local-original' },
    ] };
  const message = { id: 'public-original', cursor: '4', from: 'trend30', to: '*', kind: 'message', ts: 1, text: await encryptText(key, JSON.stringify({ v: 1, text: '已保存的公开结论', images: [] })) };
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes('/listen')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    if (path === '/api/paws/status') return Response.json({ state: 'disconnected' });
    if (path === '/api/consultations') return Response.json({ runs: [run] });
    if (path.includes('/agents/')) return Response.json({ sessionId: 'exact-session', messages: [], requests: [], hasMore: false, status: 'stopped' });
    if (path.includes('/participants')) return Response.json({ participants: [{ name: 'trend30', color: 'blue', joinedAt: 1 }] });
    if (path.includes('/messages')) return Response.json({ messages: [message] });
    if (path.startsWith('/api/parties?')) return Response.json({ parties: [party] });
    return Response.json(party);
  }));
  sessionStorage.setItem('apToken', 'test-only'); sessionStorage.setItem('apCurrentParty', party.id);
  const view = render(<PartyApp />);
  // This exercises real WebCrypto and virtual-list rendering after several
  // asynchronous requests. A 1s default is a scheduling race in the full suite,
  // not the product's loading deadline; still require the decrypted UI result.
  expect(await screen.findByText('已保存的公开结论', {}, { timeout: 5_000 })).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: /查看 trend30/ })[0]!);
  expect(await screen.findByText('source-original')).toBeTruthy();
  expect(screen.getByRole('link', { name: '在 Paws 打开原始会话' }).getAttribute('href')).toContain('/session/exact-session');
  view.unmount();
  render(<PartyApp />);
  expect(await screen.findByText('已保存的公开结论', {}, { timeout: 5_000 })).toBeTruthy();
  expect(screen.getByText(/会诊：已停止协调/)).toBeTruthy();
});

it('does not replace the new Party participants when the previous Party responds late', async () => {
  let finishOld!: (response: Response) => void;
  const parties = ['old', 'new'].map(id => ({ id, title: `${id} 会诊`, createdAt: 1, lastMessageAt: 1, messagesCount: 0, key: null }));
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes('/listen')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    if (path === '/api/paws/status') return Response.json({ state: 'disconnected' });
    if (path === '/api/consultations') return Response.json({ runs: [] });
    if (path.includes('/old/participants')) return new Promise<Response>(resolve => { finishOld = resolve; });
    if (path.includes('/new/participants')) return Response.json({ participants: [{ name: 'timing1', color: 'blue', joinedAt: 1 }] });
    if (path.includes('/messages')) return Response.json({ messages: [] });
    if (path.startsWith('/api/parties?')) return Response.json({ parties });
    return Response.json(parties.find(party => path.endsWith('/' + party.id)));
  }));
  sessionStorage.setItem('apToken', 'test-only');
  render(<PartyApp />);
  await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: /new 会诊/ }));
  await screen.findByRole('button', { name: /查看 timing1/ });
  finishOld(Response.json({ participants: [{ name: 'trend30', color: 'red', joinedAt: 1 }] }));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.getByRole('button', { name: /查看 timing1/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /查看 trend30/ })).toBeNull();
});
