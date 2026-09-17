// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PartyApp } from '../src/web/PartyApp.js';
import * as browserCrypto from '../src/web/lib/crypto.js';
import { encryptText, generatePartyKey } from '../vendor/agents-party/src/core/crypto.js';
import type { FollowUpInput, ImageRef, RunSnapshot } from '../src/contracts.js';
import type { Message } from '../vendor/agents-party/src/core/types.js';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return (this as HTMLElement).hasAttribute('data-index') ? 88 : 600; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  HTMLElement.prototype.scrollTo = () => {};
  window.matchMedia = () => ({ matches: false }) as MediaQueryList;
  URL.createObjectURL = () => 'blob:test-preview'; URL.revokeObjectURL = () => {};
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const image = (id: string): ImageRef => ({ id, name: `${id}.png`, mimeType: 'image/png', size: 5 });
const acceptedRun: RunSnapshot = { id: 'accepted', partyId: 'A', stock: 'TEST', mode: 'single', status: 'completed', phase: 'completed', createdAt: 1,
  roles: { moderator: { role: 'moderator', status: 'completed' }, trend30: { role: 'trend30', status: 'not-selected' }, structure10: { role: 'structure10', status: 'not-selected' }, timing1: { role: 'timing1', status: 'not-selected' } }, followUps: [], turns: [] };
type RequestHandler = (path: string, init?: RequestInit) => Promise<Response> | Response | undefined;

function installTransport(handle: RequestHandler = () => undefined, key: string | null = null) {
  const parties = ['A', 'B'].map(id => ({ id, title: `${id} 会诊`, createdAt: 1, lastMessageAt: 1, messagesCount: 1, key }));
  const runs: RunSnapshot[] = parties.map(party => ({ id: `run-${party.id}`, partyId: party.id, stock: 'TEST', mode: 'single', status: 'completed', phase: 'completed', createdAt: 1,
    roles: { moderator: { role: 'moderator', status: 'completed' }, trend30: { role: 'trend30', status: 'not-selected' }, structure10: { role: 'structure10', status: 'not-selected' }, timing1: { role: 'timing1', status: 'not-selected' } }, followUps: [], turns: [] }));
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const custom = handle(path, init); if (custom !== undefined) return custom;
    if (path.includes('/listen')) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    if (path === '/api/paws/status') return Response.json({ state: 'ready' });
    if (path === '/api/paws/machines') return Response.json({ machines: [] });
    if (path === '/api/consultations') return Response.json({ runs });
    if (path.includes('/participants')) return Response.json({ participants: [{ name: 'moderator', color: 'blue', joinedAt: 1 }] });
    if (path.includes('/messages')) return Response.json({ messages: [] });
    if (path.startsWith('/api/assets/')) return new Response(new Blob(['image']));
    if (path.startsWith('/api/parties?')) return Response.json({ parties });
    return Response.json(parties.find(party => path.endsWith('/' + party.id)));
  }));
  sessionStorage.setItem('apToken', 'test-only'); sessionStorage.setItem('apCurrentParty', 'A');
}
async function openB() {
  fireEvent.click(screen.getByRole('button', { name: /B 会诊/ }));
  await screen.findByRole('heading', { name: 'B 会诊' });
}
const textbox = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement;
const upload = (id: string) => fireEvent.change(screen.getByLabelText('添加图片'), { target: { files: [new File(['image'], `${id}.png`, { type: 'image/png' })] } });

async function createDraft(text: string) {
  fireEvent.click(screen.getByRole('button', { name: '新建会诊' }));
  const dialog = within(screen.getByRole('dialog', { name: '新建会诊' }));
  fireEvent.change(dialog.getByLabelText('标的'), { target: { value: text } });
  fireEvent.change(dialog.getByLabelText('机器'), { target: { value: 'machine' } });
  fireEvent.change(dialog.getByLabelText('工作目录'), { target: { value: '/explicit' } });
  fireEvent.change(dialog.getByRole('textbox', { name: '消息' }), { target: { value: text } });
  return dialog;
}

it('keeps a reopened creation draft and images when a closed submission is accepted late', async () => {
  const posted = deferred<Response>(); let submitted = false; let refreshed = 0;
  installTransport((path, init) => {
    if (path === '/api/paws/machines') return Response.json({ machines: [{ id: 'machine', active: true }] });
    if (path === '/api/consultations' && init?.method === 'POST') { submitted = true; return posted.promise; }
    if (path === '/api/assets') return Response.json(image('draft-B'));
    if (path.startsWith('/api/parties?')) refreshed++;
    return undefined;
  });
  render(<PartyApp />); await vi.waitFor(() => expect(textbox().disabled).toBe(false));
  const a = await createDraft('A'); fireEvent.click(a.getByRole('button', { name: '发送消息' }));
  await vi.waitFor(() => expect(submitted).toBe(true)); fireEvent.click(a.getByRole('button', { name: '关闭' }));
  const b = await createDraft('NEW UNSENT DRAFT');
  fireEvent.change(b.getByLabelText('添加图片'), { target: { files: [new File(['image'], 'draft-B.png', { type: 'image/png' })] } });
  await b.findByRole('button', { name: '移除 draft-B.png' }); const before = refreshed;
  await act(async () => { posted.resolve(Response.json(acceptedRun)); });
  expect(screen.getByRole('dialog', { name: '新建会诊' })).toBeTruthy();
  expect((b.getByLabelText('标的') as HTMLInputElement).value).toBe('NEW UNSENT DRAFT');
  expect((b.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('NEW UNSENT DRAFT');
  expect(b.getByRole('button', { name: '移除 draft-B.png' })).toBeTruthy();
  expect(refreshed).toBeGreaterThan(before);
});

it('does not override later Party navigation after an accepted creation awaits list refresh', async () => {
  const refresh = deferred<Response>(); let accepted = false; let refreshing = false;
  installTransport((path, init) => {
    if (path === '/api/paws/machines') return Response.json({ machines: [{ id: 'machine', active: true }] });
    if (path === '/api/consultations' && init?.method === 'POST') { accepted = true; return Response.json(acceptedRun); }
    if (path.startsWith('/api/parties?') && accepted) { refreshing = true; return refresh.promise.then(response => response.clone()); }
    return undefined;
  });
  render(<PartyApp />); await vi.waitFor(() => expect(textbox().disabled).toBe(false));
  const a = await createDraft('A'); fireEvent.click(a.getByRole('button', { name: '发送消息' }));
  await vi.waitFor(() => expect(refreshing).toBe(true)); await openB();
  await act(async () => { refresh.resolve(Response.json({ parties: ['A', 'B'].map(id => ({ id, title: `${id} 会诊`, key: null, createdAt: 1, lastMessageAt: 1, messagesCount: 1 })) })); });
  expect(screen.getByRole('heading', { name: 'B 会诊' })).toBeTruthy();
});

it('isolates deferred uploads and busy state when Party A unmounts and Party B starts uploading', async () => {
  const a = deferred<Response>(); const b = deferred<Response>();
  const uploads: Array<{ name: string; signal: AbortSignal | null | undefined }> = [];
  installTransport((path, init) => {
    if (path !== '/api/assets') return undefined;
    const name = new Headers(init?.headers).get('x-filename')!;
    uploads.push({ name, signal: init?.signal }); return name === 'A.png' ? a.promise : b.promise;
  });
  render(<PartyApp />);
  await vi.waitFor(() => expect(textbox().disabled).toBe(false));
  upload('A'); await vi.waitFor(() => expect(uploads).toHaveLength(1));
  await openB();
  expect(textbox().disabled).toBe(false);
  upload('B'); await vi.waitFor(() => expect(uploads).toHaveLength(2));
  await act(async () => { a.resolve(Response.json(image('A'))); });
  expect(screen.queryByRole('button', { name: '移除 A.png' })).toBeNull();
  expect(textbox().disabled).toBe(true);
  expect(uploads[0]!.signal?.aborted).toBe(true);
  await act(async () => { b.resolve(Response.json(image('B'))); });
  expect(await screen.findByRole('button', { name: '移除 B.png' })).toBeTruthy();
  expect(textbox().disabled).toBe(false);
});

it.each([200, 400])('preserves B attachments and ambiguous retry identity after A responds %s', async status => {
  const a = deferred<Response>(); const b = deferred<Response>();
  const sends: Array<{ path: string; input: FollowUpInput }> = [];
  installTransport((path, init) => {
    if (path === '/api/assets') return Response.json(image('B'));
    if (init?.method !== 'POST' || !path.startsWith('/api/consultations/')) return undefined;
    sends.push({ path, input: JSON.parse(String(init.body)) });
    if (path.includes('run-A')) return a.promise;
    return sends.filter(send => send.path.includes('run-B')).length === 1 ? b.promise : Response.json({ accepted: true });
  });
  render(<PartyApp />);
  await vi.waitFor(() => expect(textbox().disabled).toBe(false));
  fireEvent.change(textbox(), { target: { value: 'A follow-up' } }); fireEvent.click(sendButton());
  await vi.waitFor(() => expect(sends).toHaveLength(1));
  await openB(); upload('B'); await screen.findByRole('button', { name: '移除 B.png' });
  fireEvent.change(textbox(), { target: { value: 'B follow-up' } }); fireEvent.click(sendButton());
  await vi.waitFor(() => expect(sends).toHaveLength(2));
  await act(async () => { a.resolve(Response.json(status === 200 ? { accepted: true } : { error: 'A rejected' }, { status })); });
  expect(screen.getByRole('button', { name: '移除 B.png' })).toBeTruthy();
  await act(async () => { b.reject(new TypeError('B response uncertain')); });
  expect(await screen.findByText('B response uncertain')).toBeTruthy();
  fireEvent.click(sendButton());
  await vi.waitFor(() => expect(sends).toHaveLength(3));
  expect(sends[2]!.input.requestId).toBe(sends[1]!.input.requestId);
  expect(sends[2]!.input.images).toEqual([image('B')]);
  expect(sends[2]!.input.text).toBe('B follow-up');
});

it('keeps a new listen message visible when an older-page decrypt completes last', async () => {
  const key = generatePartyKey();
  const encrypted = async (cursor: number, text: string): Promise<Message> => ({ id: `message-${cursor}`, cursor: String(cursor), from: 'moderator', to: '*', kind: 'message', ts: cursor, text: await encryptText(key, text) });
  const firstPage = await Promise.all(Array.from({ length: 50 }, (_, index) => encrypted(index + 2, `history-${index + 2}`)));
  const older = await encrypted(1, 'oldest message'); const newest = await encrypted(52, 'newest received message');
  const olderPage = deferred<Response>(); const listen = deferred<Response>(); const oldDecode = deferred<void>();
  let olderRequested = false; let listenRequested = false; let deferredOnce = false;
  const decrypt = browserCrypto.decrypt;
  vi.spyOn(browserCrypto, 'decrypt').mockImplementation(async (key, text) => {
    if (text === older.text && !deferredOnce) { deferredOnce = true; await oldDecode.promise; }
    return decrypt(key, text);
  });
  installTransport(path => {
    if (path.includes('/A/listen') && !listenRequested) { listenRequested = true; return listen.promise; }
    if (path.includes('/A/messages')) {
      if (path.includes('before=')) { olderRequested = true; return olderPage.promise; }
      return Response.json({ messages: firstPage });
    }
    return undefined;
  }, key);
  const { container } = render(<PartyApp />);
  await vi.waitFor(() => expect(listenRequested).toBe(true));
  const scroll = container.querySelector('main .overflow-y-auto.flex-1.px-4')!;
  expect(scroll).not.toBeNull(); fireEvent.scroll(scroll);
  await vi.waitFor(() => expect(olderRequested).toBe(true));
  await act(async () => { olderPage.resolve(Response.json({ messages: [older] })); });
  await vi.waitFor(() => expect(deferredOnce).toBe(true));
  await act(async () => { listen.resolve(Response.json({ messages: [newest] })); });
  // Move the real virtualizer to the newest rows without requesting another receive.
  Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 4600, writable: true }); fireEvent.scroll(scroll);
  expect(await screen.findByText('newest received message')).toBeTruthy();
  await act(async () => { oldDecode.resolve(); });
  expect(screen.getByText('newest received message')).toBeTruthy();
});
