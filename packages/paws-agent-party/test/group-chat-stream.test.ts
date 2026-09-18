import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { MessageWatchOptions, SendMessageInput, PawsAgentEvent } from '@wangjs-jacky/paws-agent';
import { createPocServer, type PocServer } from '../src/server/http.js';
import type { GroupRoomSnapshot } from '../src/group-chat/rooms.js';
import { TestOnlySdk } from './fake-sdk.js';

type Delta = Extract<PawsAgentEvent, { type: 'text-delta' }>;
class StreamingSdk extends TestOnlySdk {
  listeners = new Set<(event: Delta) => void>();
  watchers = new Map<string, MessageWatchOptions>();
  input?: SendMessageInput;
  seq = 0;
  subscribeText(listener: (event: Delta) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  override async watch(id: string, options: MessageWatchOptions) {
    this.watchers.set(id, options);
    return { unsubscribe: () => { this.watchers.delete(id); }, sync: async () => {} };
  }
  override async send(input: SendMessageInput) {
    this.input = input;
    this.pushMessage({ role: 'user' }, input.localId!);
    this.emitEvent('root', { t: 'turn-start' });
    return { sessionId: input.sessionId, localId: input.localId! };
  }
  pushMessage(content: unknown, localId: string | null = null) {
    const seq = ++this.seq;
    this.watchers.get(this.input!.sessionId)?.onMessage({ id: `message-${seq}`, seq, content, localId, createdAt: seq, updatedAt: seq });
  }
  emitEvent(turn: string, ev: Record<string, unknown>, item = 'answer') {
    this.pushMessage({ role: 'session', content: { id: `event-${this.seq}`, role: 'agent', turn, codexItemId: item, ev } });
  }
  delta(text: string, turnId = 'root', sessionId = this.input!.sessionId, itemId = 'answer') {
    for (const listener of this.listeners) listener({ type: 'text-delta', sessionId, turnId, itemId, text, delta: text });
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'party-stream-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const sdk = new StreamingSdk(); const server = await createPocServer({ dataDir: dir, sdk, accessToken: 'test', turnTimeoutMs: 10000 }); cleanups.push(() => server.close());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/api/group-chat${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(200); return response.json();
  };
  const { agents } = await call('/agents');
  const room: GroupRoomSnapshot = await call('/rooms', { requestId: 'create', title: '流式测试', memberIds: [agents[0].id, agents[1].id], machineId: 'machine-1', directory: '/tmp', autoDebate: true, maxRounds: 1 });
  const current = () => call(`/rooms/${room.id}`) as Promise<GroupRoomSnapshot>;
  await call(`/rooms/${room.id}/messages`, { requestId: 'send', text: `@${agents[0].name} @${agents[1].name} 讨论`, images: [] });
  await until(() => expect(sdk.input).toBeDefined());
  return { server, sdk, room, call, current };
}
async function until(assertion: () => void | Promise<void>) { const end = Date.now() + 3000; let error: unknown; while (Date.now() < end) { try { await assertion(); return; } catch (e) { error = e; await new Promise(r => setTimeout(r, 10)); } } throw error; }

it('exposes cumulative text before completion, rejects unrelated turns, and reconciles durable text', async () => {
  const t = await setup();
  t.sdk.delta('wrong', 'other'); t.sdk.delta('wrong-session', 'root', 'foreign');
  t.sdk.delta('第一');
  await until(async () => expect((await t.current()).turns[0]?.live).toMatchObject({ text: '第一', status: 'running' }));
  expect((await t.current()).debate?.completedTurns).toBe(0);
  t.sdk.delta('第一段'); t.sdk.delta('第一段');
  expect((await t.current()).turns[0]?.live?.text).toBe('第一段');
  t.sdk.emitEvent('root', { t: 'text', text: '第一段最终版' });
  t.sdk.delta('过期增量');
  expect((await t.current()).turns[0]?.live?.text).toBe('第一段最终版');
  t.sdk.emitEvent('root', { t: 'turn-end', status: 'completed' });
  await until(async () => expect((await t.current()).turns[0]?.publicMessageId).toBeTruthy());
  expect((await t.current()).turns[0]?.live).toMatchObject({ text: '第一段最终版', status: 'completed' });
});

it('retains partial output after stop and ignores late chunks without starting another participant', async () => {
  const t = await setup(); t.sdk.delta('已输出');
  await t.call(`/rooms/${t.room.id}/debate/stop`, {});
  t.sdk.delta('不应显示');
  const room = await t.current();
  expect(room.turns).toHaveLength(1);
  expect(room.turns[0]?.live).toMatchObject({ text: '已输出', status: 'stopped' });
  expect(t.sdk.listeners.size).toBe(0);
});

it('retains partial output on remote failure and does not publish it as a completed reply', async () => {
  const t = await setup(); t.sdk.delta('尚未完成');
  t.sdk.emitEvent('root', { t: 'turn-end', status: 'failed' });
  await until(async () => expect((await t.current()).debate?.status).toBe('failed'));
  const room = await t.current();
  expect(room.turns[0]?.live).toMatchObject({ text: '尚未完成', status: 'failed' });
  expect(room.turns[0]?.publicMessageId).toBeUndefined();
  expect(room.turns).toHaveLength(1);
});

it('provides durable public text as a fallback without exposing thinking or child output', async () => {
  const t = await setup();
  t.sdk.emitEvent('root', { t: 'text', text: 'private', thinking: true });
  t.sdk.pushMessage({ role: 'session', content: { role: 'agent', turn: 'root', subagent: 'child', ev: { t: 'text', text: 'child-secret' } } });
  t.sdk.emitEvent('root', { t: 'text', text: '公开内容' });
  expect((await t.current()).turns[0]?.live?.text).toBe('公开内容');
  t.sdk.delta('wrong', 'old-root');
  expect((await t.current()).turns[0]?.live?.text).toBe('公开内容');
});

it('authenticates the live endpoint and streams a snapshot before the turn finishes', async () => {
  const t = await setup(); const url = `${t.server.url}/api/group-chat/rooms/${t.room.id}/events`;
  expect((await fetch(url)).status).toBe(401);
  const abort = new AbortController(); cleanups.push(async () => abort.abort());
  const response = await fetch(url, { headers: { authorization: 'Bearer test' }, signal: abort.signal });
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain(t.room.id);
  t.sdk.delta('真实事件');
  let data = ''; while (!data.includes('真实事件')) data += new TextDecoder().decode((await reader.read()).value);
  expect(data).toContain('running'); abort.abort();
});
