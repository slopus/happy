import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPocServer, type PocServer } from '../src/server/http.js';
import type { GroupRoomSnapshot } from '../src/group-chat/rooms.js';
import { TestOnlySdk } from './fake-sdk.js';
import { AssetStore } from '../src/server/assets.js';

const token = 'incremental-test';
const servers = new Set<PocServer>(); const dirs: string[] = [];
afterEach(async () => { for (const server of servers) await server.close(); servers.clear(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function request<T>(server: PocServer, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server.url}/api/group-chat${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<T>;
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'party-incremental-')); dirs.push(dir);
  const sdk = new TestOnlySdk();
  const server = await createPocServer({ dataDir: dir, accessToken: token, sdk: sdk as never }); servers.add(server);
  const { agents } = await request<{ agents: { id: string; name: string }[] }>(server, '/agents');
  const room = await request<GroupRoomSnapshot>(server, '/rooms', { requestId: crypto.randomUUID(), title: '增量', memberIds: agents.slice(0, 2).map(a => a.id), directory: '/tmp/work', machineId: 'machine-1', autoReply: false });
  return { dir, sdk, server, room };
}
async function send(server: PocServer, room: GroupRoomSnapshot, text: string) { await request(server, `/rooms/${room.id}/messages`, { requestId: crypto.randomUUID(), text, images: [] }); }
async function settled(server: PocServer, room: GroupRoomSnapshot, count: number, status = 'completed') {
  await expect.poll(async () => { const current = await request<GroupRoomSnapshot>(server, `/rooms/${room.id}`); return current.turns.length === count && (status !== 'completed' || Boolean(current.turns.at(-1)?.publicMessageId)) && current.members.some(m => m.status === status) && !current.members.some(m => ['running', 'spawning'].includes(m.status)); }).toBe(true);
}

it('keeps independent read positions and does not lose messages arriving during execution', async () => {
  const t = await setup(); const [a, b] = t.room.members;
  await send(t.server, t.room, '最初背景-ALPHA');
  let release!: () => void; t.sdk.holdNextDelivery(new Promise<void>(resolve => { release = resolve; }));
  try {
    await send(t.server, t.room, `@${a!.name} 首次发言`);
    await expect.poll(() => t.sdk.calls.length).toBe(1);
    await send(t.server, t.room, '执行期间新增-BETA');
  } finally { release(); }
  await settled(t.server, t.room, 1);
  await send(t.server, t.room, `@${a!.name} 第二次发言`); await settled(t.server, t.room, 2);
  expect(t.sdk.calls[1]!.text).toContain('执行期间新增-BETA');
  expect(t.sdk.calls[1]!.text).not.toContain('最初背景-ALPHA');
  expect(t.sdk.calls[1]!.text).not.toContain(`public-${a!.id}-1`);
  await send(t.server, t.room, `@${b!.name} 请补读`); await settled(t.server, t.room, 3);
  expect(t.sdk.calls[2]!.text).toContain('最初背景-ALPHA');
  expect(t.sdk.calls[2]!.text).toContain(`public-${a!.id}-1`);
  expect(t.sdk.calls[2]!.text).toContain(`public-${a!.id}-2`);
});

it('does not advance unread context when remote delivery fails', async () => {
  const t = await setup(); const a = t.room.members[0]!;
  const original = t.sdk.send.bind(t.sdk); t.sdk.send = async () => { throw new Error('offline'); };
  await send(t.server, t.room, `@${a.name} 不能丢失-GAMMA`); await settled(t.server, t.room, 1, 'failed');
  t.sdk.send = original;
  await send(t.server, t.room, `@${a.name} 重试`); await settled(t.server, t.room, 2);
  expect(t.sdk.calls[0]!.text).toContain('不能丢失-GAMMA');
});

it('retains current-message attachment scope without merging an oversized historical image backlog', async () => {
  const t = await setup(); const a = t.room.members[0]!; const store = new AssetStore(t.dir);
  const images = await Promise.all(Array.from({ length: 5 }, (_, i) => store.put({ name: `image-${i}.png`, mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) })));
  for (const image of images.slice(0, 4)) await request(t.server, `/rooms/${t.room.id}/messages`, { requestId: crypto.randomUUID(), text: '归档图片', images: [image] });
  await request(t.server, `/rooms/${t.room.id}/messages`, { requestId: crypto.randomUUID(), text: `@${a.name} 看本次图片`, images: [images[4]] });
  await settled(t.server, t.room, 1);
  expect(t.sdk.calls[0]!.images?.map(image => image.name)).toEqual(['image-4.png']);
});

it('preserves the delivery cursor across a service restart', async () => {
  const t = await setup(); const a = t.room.members[0]!;
  await send(t.server, t.room, `@${a.name} 已处理-DELTA`); await settled(t.server, t.room, 1);
  await t.server.close(); servers.delete(t.server);
  const next = await createPocServer({ dataDir: t.dir, accessToken: token, sdk: t.sdk as never }); servers.add(next);
  await send(next, t.room, `@${a.name} 新消息-EPSILON`); await settled(next, t.room, 2);
  expect(t.sdk.calls[1]!.text).not.toContain('已处理-DELTA');
  expect(t.sdk.calls[1]!.text).toContain('新消息-EPSILON');
  expect(t.sdk.spawnCalls).toBe(1);
});

it('does not mark an interrupted input read when a late remote completion arrives', async () => {
  const t = await setup(); const a = t.room.members[0]!;
  let release!: () => void; t.sdk.holdNextDelivery(new Promise<void>(resolve => { release = resolve; }));
  try {
    await send(t.server, t.room, `@${a.name} 停止前未完成-THETA`);
    await expect.poll(() => t.sdk.calls.length).toBe(1);
    await request(t.server, `/rooms/${t.room.id}/stop`, {});
  } finally { release(); }
  await settled(t.server, t.room, 1, 'stopped');
  await send(t.server, t.room, `@${a.name} 再试一次`); await settled(t.server, t.room, 2);
  expect(t.sdk.calls[1]!.text).toContain('停止前未完成-THETA');
});

it('refuses oversized unseen input without silently discarding the earliest messages', async () => {
  const t = await setup(); const a = t.room.members[0]!;
  for (let i = 0; i < 6; i++) await send(t.server, t.room, 'x'.repeat(19000));
  await send(t.server, t.room, `@${a.name} 处理全部历史`); await settled(t.server, t.room, 1, 'failed');
  expect(t.sdk.calls).toHaveLength(0);
  const current = await request<GroupRoomSnapshot>(t.server, `/rooms/${t.room.id}`);
  expect(current.members[0]!.error).toContain('Unread group context exceeds');
  await t.server.close(); servers.delete(t.server);
  const stored = JSON.parse(await readFile(join(t.dir, 'group-chat-rooms.json'), 'utf8'));
  expect(stored.rooms[0].deliveries?.[a.id]).toBeUndefined();
});

it('bootstraps old public replies when a different remote session replaces the original', async () => {
  const t = await setup(); const a = t.room.members[0]!;
  await send(t.server, t.room, `@${a.name} 重建背景-ZETA`); await settled(t.server, t.room, 1);
  await t.server.close(); servers.delete(t.server);
  const path = join(t.dir, 'group-chat-rooms.json'); const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.rooms[0].snapshot.members[0].sessionId = 'session-replacement'; stored.rooms[0].cursors[a.id] = 0;
  await writeFile(path, JSON.stringify(stored));
  const next = await createPocServer({ dataDir: t.dir, accessToken: token, sdk: t.sdk as never }); servers.add(next);
  await send(next, t.room, `@${a.name} 继续`); await settled(next, t.room, 2);
  expect(t.sdk.calls[1]!.text).toContain('重建背景-ZETA');
  expect(t.sdk.calls[1]!.text).toContain(`public-${a.id}-1`);
});
