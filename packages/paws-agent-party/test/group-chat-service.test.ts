import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupRoomSnapshot } from '../src/group-chat/rooms.js';
import { createPocServer, type PocServer } from '../src/server/http.js';
import { TestOnlySdk } from './fake-sdk.js';

const token = 'group-test-token';
const servers: PocServer[] = []; const dirs: string[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const auth = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
async function start() { const dir = await mkdtemp(join(tmpdir(), 'paws-agent-party-group-')); dirs.push(dir); const sdk = new TestOnlySdk(); const server = await createPocServer({ dataDir: dir, accessToken: token, sdk: sdk as never, turnTimeoutMs: 1000 }); servers.push(server); return { server, sdk, dir }; }
async function json<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, auth(init)); if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<T>; }

describe('generic group chat', () => {
  it('freezes the Codex model/effort at room creation and forwards that snapshot on spawn', async () => {
    const { server, sdk } = await start(); const spawn = vi.spyOn(sdk, 'spawn'); const send = vi.spyOn(sdk, 'send');
    const profile = await json<{ id: string }>(`${server.url}/api/group-chat/agents`, { method: 'POST', body: JSON.stringify({ name: '架构师', instructions: '分析架构', model: 'gpt-5.6-terra', effort: 'high' }) });
    const room = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'frozen-room', title: '模型配置', memberIds: [profile.id], machineId: 'machine-1', directory: '/tmp/work' }) });
    expect(room.members[0]).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra', effort: 'high' });
    await json(`${server.url}/api/group-chat/agents/${profile.id}`, { method: 'PATCH', body: JSON.stringify({ name: '架构师', instructions: '新的角色', model: 'gpt-5.6-luna', effort: 'low' }) });
    await json(`${server.url}/api/group-chat/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: 'frozen-message', text: '@架构师 给出观点', images: [] }) });
    await eventually(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', model: 'gpt-5.6-terra', effort: 'high' })));
    await eventually(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ meta: { model: 'gpt-5.6-terra', effort: 'high' } })));
    const unchanged = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms/${room.id}`);
    expect(unchanged.members[0]).toMatchObject({ instructions: '分析架构', model: 'gpt-5.6-terra', effort: 'high' });
  });

  it('migrates legacy rooms to luna/low and starts a fresh Codex session instead of reusing unknown launch settings', async () => {
    const { server, dir } = await start(); const profiles = await json<{ agents: Array<{ id: string; name: string }> }>(`${server.url}/api/group-chat/agents`);
    const agent = profiles.agents[0]!;
    const room = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'legacy-room', title: '旧房间', memberIds: [agent.id], machineId: 'machine-1', directory: '/tmp/work' }) });
    await server.close(); servers.splice(servers.indexOf(server), 1);
    const path = join(dir, 'group-chat-rooms.json'); const stored = JSON.parse(await readFile(path, 'utf8'));
    const member = stored.rooms[0].snapshot.members[0]; delete member.model; delete member.effort; member.engine = 'claude'; member.sessionId = 'legacy-claude-session'; stored.rooms[0].cursors[agent.id] = 9999;
    await writeFile(path, JSON.stringify(stored));
    const sdk = new TestOnlySdk(); const spawn = vi.spyOn(sdk, 'spawn');
    const reopened = await createPocServer({ dataDir: dir, accessToken: token, sdk: sdk as never }); servers.push(reopened);
    const migrated = await json<GroupRoomSnapshot>(`${reopened.url}/api/group-chat/rooms/${room.id}`);
    expect(migrated.members[0]).toMatchObject({ engine: 'codex', model: 'gpt-5.6-luna', effort: 'low' }); expect(migrated.members[0]!.sessionId).toBeUndefined();
    await json(`${reopened.url}/api/group-chat/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: 'legacy-message', text: `@${agent.name} 你好`, images: [] }) });
    await eventually(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', model: 'gpt-5.6-luna', effort: 'low' })));
  });

  it('creates reusable profiles, freezes them in a room, and only dispatches explicit @ members', async () => {
    const { server, sdk } = await start();
    const profiles = await json<{ agents: Array<{ id: string; name: string }> }>(`${server.url}/api/group-chat/agents`);
    const product = profiles.agents.find(agent => agent.name === '产品经理')!;
    const tech = profiles.agents.find(agent => agent.name === '技术负责人')!;
    const room = await json<{ id: string; members: Array<{ id: string }> }>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'room-1', title: '发布讨论', memberIds: [product.id, tech.id], machineId: 'machine-1', directory: '/tmp/work', autoReply: false }) });
    expect(room.members.map(member => member.id)).toEqual([product.id, tech.id]);
    await json(`${server.url}/api/group-chat/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: 'message-1', text: '@技术负责人 看看交付风险', images: [] }) });
    await eventually(() => expect(sdk.calls.map(call => call.role)).toEqual([tech.id]));
    expect(sdk.calls[0]?.text).toContain('@技术负责人 看看交付风险');
  });

  it('records plain messages with auto off, and refuses to replace an invalid @ with auto-routing', async () => {
    const { server, sdk } = await start(); const profiles = await json<{ agents: Array<{ id: string }> }>(`${server.url}/api/group-chat/agents`);
    const room = await json<{ id: string }>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'room-2', title: '安静记录', memberIds: [profiles.agents[0]!.id], machineId: 'machine-1', directory: '/tmp/work', autoReply: false }) });
    await json(`${server.url}/api/group-chat/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: 'message-2', text: '先记录这个想法', images: [] }) });
    await new Promise(resolve => setTimeout(resolve, 60)); expect(sdk.calls).toHaveLength(0);
    const invalid = await fetch(`${server.url}/api/group-chat/rooms/${room.id}/messages`, auth({ method: 'POST', body: JSON.stringify({ requestId: 'message-3', text: '@研究员 帮我看看', images: [] }) }));
    expect(invalid.status).toBe(400); expect(sdk.calls).toHaveLength(0);
  });

  it('rejects shorthand working directories before a room can dispatch an Agent', async () => {
    const { server } = await start(); const profiles = await json<{ agents: Array<{ id: string }> }>(`${server.url}/api/group-chat/agents`);
    const response = await fetch(`${server.url}/api/group-chat/rooms`, auth({ method: 'POST', body: JSON.stringify({ requestId: 'room-home', title: '错误目录', memberIds: [profiles.agents[0]!.id], machineId: 'machine-1', directory: '~', autoReply: true }) }));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('absolute working directory');
  });

  it('invites permanent and temporary agents atomically and uses each member machine configuration', async () => {
    const { server, sdk } = await start(); const spawn = vi.spyOn(sdk, 'spawn');
    const permanent = await json<{ id: string }>(`${server.url}/api/group-chat/agents`, { method: 'POST', body: JSON.stringify({ name: '远端成员', instructions: '远端处理', avatarId: 4, machineId: 'machine-2', directory: '/srv/remote' }) });
    const seeded = await json<{ agents: Array<{ id: string }> }>(`${server.url}/api/group-chat/agents`);
    const room = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'invite-room', title: '邀请', memberIds: [seeded.agents[0]!.id], machineId: 'machine-1', directory: '/tmp/work', autoReply: false }) });
    const admitted = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms/${room.id}/members`, { method: 'POST', body: JSON.stringify({ requestId: 'invite-1', memberIds: [permanent.id, permanent.id], temporary: [{ name: '临时顾问', instructions: '临时分析', avatarId: 7 }] }) });
    expect(admitted.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: permanent.id, avatarId: 4, machineId: 'machine-2', directory: '/srv/remote' }), expect.objectContaining({ name: '临时顾问', avatarId: 7, temporary: true })]));
    const retry = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms/${room.id}/members`, { method: 'POST', body: JSON.stringify({ requestId: 'invite-1', temporary: [{ name: 'ignored', instructions: 'ignored' }] }) });
    expect(retry.members).toHaveLength(admitted.members.length);
    const library = await json<{ agents: Array<{ name: string }> }>(`${server.url}/api/group-chat/agents`);
    expect(library.agents.some(agent => agent.name === '临时顾问')).toBe(false);
    const bad = await fetch(`${server.url}/api/group-chat/rooms/${room.id}/members`, auth({ method: 'POST', body: JSON.stringify({ requestId: 'invite-bad', temporary: [{ name: '临时顾问', instructions: 'duplicate' }, { name: 'new', instructions: '' }] }) }));
    expect(bad.status).toBe(400);
    expect((await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms/${room.id}`)).members).toHaveLength(admitted.members.length);
    await json(`${server.url}/api/group-chat/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: 'per-member-spawn', text: '@远端成员 执行', images: [] }) });
    await eventually(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-2', directory: '/srv/remote' })));
  });

  it('deletes an idle room durably and rejects deletion during active work', async () => {
    const { server, sdk, dir } = await start(); const profiles = await json<{ agents: Array<{ id: string; name: string }> }>(`${server.url}/api/group-chat/agents`); const agent = profiles.agents[0]!;
    const room = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'delete-room', title: '删除', memberIds: [agent.id], machineId: 'machine-1', directory: '/tmp/work' }) });
    let release!: () => void; sdk.holdNextDelivery(new Promise<void>(resolve => { release = resolve; }));
    await json(`${server.url}/api/group-chat/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify({ requestId: 'busy', text: `@${agent.name} 工作`, images: [] }) });
    await eventually(() => expect(sdk.calls).toHaveLength(1));
    expect((await fetch(`${server.url}/api/group-chat/rooms/${room.id}`, auth({ method: 'DELETE' }))).status).toBe(409);
    release(); await eventually(async () => expect((await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms/${room.id}`)).members[0]!.status).toBe('completed'));
    await eventually(async () => expect((await fetch(`${server.url}/api/group-chat/rooms/${room.id}`, auth({ method: 'DELETE' }))).status).toBe(200));
    expect((await fetch(`${server.url}/api/group-chat/rooms/${room.id}`, auth())).status).toBe(404);
    const persisted = JSON.parse(await readFile(join(dir, 'group-chat-rooms.json'), 'utf8'));
    expect(persisted.rooms).toHaveLength(0); expect(persisted.requestIds).toEqual({});
  });

  it('exposes SDK directory discovery and an explicit unavailable machine configuration capability', async () => {
    const { server, sdk } = await start(); const browse = vi.spyOn(sdk, 'browseDirectory');
    const listing = await json<{ path: string }>(`${server.url}/api/paws/machines/machine-1/directories?path=${encodeURIComponent('/tmp')}`);
    expect(listing.path).toBe('/tmp'); expect(browse).toHaveBeenCalledWith('machine-1', '/tmp');
    await expect(json<{ available: boolean }>(`${server.url}/api/paws/machines/machine-1/configuration`)).resolves.toEqual(expect.objectContaining({ available: false }));
  });

  it('rejects malformed invitation request ids and temporary configuration with 400', async () => {
    const { server } = await start(); const profiles = await json<{ agents: Array<{ id: string }> }>(`${server.url}/api/group-chat/agents`);
    const room = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'malformed-room', title: '校验', memberIds: [profiles.agents[0]!.id], machineId: 'machine-1', directory: '/tmp/work' }) });
    for (const body of [
      { requestId: 1, temporary: [] },
      { requestId: 'bad-avatar', temporary: [{ name: '坏头像', instructions: '拒绝', avatarId: null }] },
      { requestId: 'bad-machine', temporary: [{ name: '坏机器', instructions: '拒绝', machineId: 1, directory: '/tmp' }] },
    ]) expect((await fetch(`${server.url}/api/group-chat/rooms/${room.id}/members`, auth({ method: 'POST', body: JSON.stringify(body) }))).status).toBe(400);
  });

  it('closes an events stream safely when its room is deleted during a pending debounce', async () => {
    const { server } = await start(); const profiles = await json<{ agents: Array<{ id: string }> }>(`${server.url}/api/group-chat/agents`);
    const room = await json<GroupRoomSnapshot>(`${server.url}/api/group-chat/rooms`, { method: 'POST', body: JSON.stringify({ requestId: 'sse-delete-room', title: 'SSE 删除', memberIds: [profiles.agents[0]!.id], machineId: 'machine-1', directory: '/tmp/work' }) });
    const controller = new AbortController(); const stream = await fetch(`${server.url}/api/group-chat/rooms/${room.id}/events`, auth({ signal: controller.signal }));
    await json(`${server.url}/api/group-chat/rooms/${room.id}/members`, { method: 'POST', body: JSON.stringify({ requestId: 'schedule-event', temporary: [{ name: '临时流', instructions: '触发更新' }] }) });
    expect((await fetch(`${server.url}/api/group-chat/rooms/${room.id}`, auth({ method: 'DELETE' }))).status).toBe(200);
    await expect(stream.text()).resolves.toContain('data:');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect((await fetch(`${server.url}/api/group-chat/rooms`, auth())).status).toBe(200);
    controller.abort();
  });
});

async function eventually(assertion: () => void | Promise<void>): Promise<void> { let last: unknown; for (let i = 0; i < 30; i += 1) { try { await assertion(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 20)); } } throw last; }
