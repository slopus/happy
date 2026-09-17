import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPocServer, type PocServer } from '../src/server/http.js';
import type { GroupRoomSnapshot } from '../src/group-chat/rooms.js';
import { TestOnlySdk } from './fake-sdk.js';

const token = 'debate-test-token';
const servers = new Set<PocServer>(); const dirs: string[] = [];
afterEach(async () => { await Promise.all([...servers].map(server => server.close())); servers.clear(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function request(server: PocServer, path: string, body?: unknown, method = 'POST') {
  return fetch(`${server.url}/api/group-chat${path}`, { method: body === undefined ? 'GET' : method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function value<T>(server: PocServer, path: string, body?: unknown, method?: string): Promise<T> { const response = await request(server, path, body, method); if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<T>; }
async function setup(options: { sdk?: TestOnlySdk; dataDir?: string; maxRounds?: number; autoDebate?: boolean } = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'paws-debate-')); if (!options.dataDir) dirs.push(dataDir);
  const sdk = options.sdk ?? new TestOnlySdk(); const server = await createPocServer({ dataDir, sdk: sdk as never, accessToken: token, turnTimeoutMs: 2000 }); servers.add(server);
  const { agents } = await value<{ agents: { id: string; name: string }[] }>(server, '/agents');
  const room = await value<GroupRoomSnapshot>(server, '/rooms', { requestId: crypto.randomUUID(), title: '辩论', memberIds: agents.slice(0, 2).map(agent => agent.id), machineId: 'machine-1', directory: '/tmp/work', autoDebate: options.autoDebate ?? true, maxRounds: options.maxRounds ?? 2 });
  const message = (requestId: string = crypto.randomUUID()) => request(server, `/rooms/${room.id}/messages`, { requestId, text: `@${agents[0]!.name} @${agents[1]!.name} 讨论这个方案`, images: [] });
  const current = () => value<GroupRoomSnapshot>(server, `/rooms/${room.id}`);
  return { server, sdk, room, agents, message, current, dataDir };
}
async function eventually(assertion: () => Promise<void> | void) { let last: unknown; const deadline = Date.now() + 15_000; while (Date.now() < deadline) { try { await assertion(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 25)); } } throw last; }
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe('bounded room debate', () => {
  it('alternates twenty sequential public responses at the ten-round cap and preserves opponent context', async () => {
    const t = await setup({ maxRounds: 10 }); expect((await t.message()).status).toBe(200);
    await eventually(async () => { const debate = (await t.current()).debate; expect(debate?.status).toBe('completed'); expect(debate?.terminalMessageId).toBeTruthy(); });
    const final = await t.current(); const [a, b] = t.room.members;
    expect(t.sdk.calls.map(call => call.role)).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 ? b : a)!.id));
    expect(final.debate).toMatchObject({ completedRounds: 10, completedTurns: 20, maxRounds: 10, nextMemberId: null });
    expect(final.turns).toHaveLength(20);
    expect(t.sdk.calls[0]!.text).toContain('立论'); expect(t.sdk.calls[1]!.text).toContain(`public-${a!.id}-1`);
    expect(t.sdk.calls[2]!.text).toContain('交锋 2'); expect(t.sdk.calls[2]!.text).toContain(`public-${b!.id}-1`);
    expect(t.sdk.calls[2]!.text).not.toContain(`public-${a!.id}-1`);
    expect(t.sdk.calls[2]!.text).not.toContain('立论');
    expect(t.sdk.calls[4]!.text).not.toContain(`public-${b!.id}-1`);
    expect(t.sdk.calls[4]!.text).toContain(`public-${b!.id}-2`);
    expect(t.sdk.calls.every(call => !call.text.includes('tool-secret'))).toBe(true);
    await eventually(async () => {
      const stored = JSON.parse(await readFile(join(t.dataDir, 'group-chat-rooms.json'), 'utf8'));
      expect(stored.rooms[0].snapshot.debate.terminalMessageId).toBeTruthy();
    });
  }, 20_000);

  it('stops an in-flight turn and ignores its later delivery without scheduling the next member', async () => {
    const sdk = new TestOnlySdk(); const pending = gate(); sdk.holdNextDelivery(pending.promise); const t = await setup({ sdk });
    await t.message(); await eventually(() => expect(sdk.calls).toHaveLength(1));
    expect((await request(t.server, `/rooms/${t.room.id}/debate/stop`, {})).status).toBe(200);
    pending.resolve(); await eventually(async () => expect((await t.current()).members[0]!.status).toBe('stopped'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sdk.calls).toHaveLength(1); expect((await t.current()).debate?.status).toBe('stopped'); expect(sdk.sessionsStopped).toBe(0);
  });

  it('fails the debate without scheduling another participant when a turn fails', async () => {
    const t = await setup(); t.sdk.send = async () => { throw new Error('provider unavailable'); };
    await t.message(); await eventually(async () => expect((await t.current()).debate?.status).toBe('failed'));
    expect((await t.current()).debate?.stopReason).toContain('provider unavailable'); expect(t.sdk.spawnCalls).toBe(1);
  });

  it('interrupts an active debate on shutdown/restart and never replays it', async () => {
    const sdk = new TestOnlySdk(); const pending = gate(); sdk.holdNextDelivery(pending.promise); const t = await setup({ sdk });
    await t.message(); await eventually(() => expect(sdk.calls).toHaveLength(1));
    await t.server.close(); servers.delete(t.server); pending.resolve();
    // Simulate the durable record left by an abrupt process exit, not just graceful close.
    const path = join(t.dataDir, 'group-chat-rooms.json'); const stored = JSON.parse(await readFile(path, 'utf8'));
    stored.rooms[0].snapshot.debate.status = 'running'; stored.rooms[0].snapshot.members[0].status = 'running';
    await writeFile(path, JSON.stringify(stored));
    const nextSdk = new TestOnlySdk(); const next = await createPocServer({ dataDir: t.dataDir, sdk: nextSdk as never, accessToken: token }); servers.add(next);
    const room = await value<GroupRoomSnapshot>(next, `/rooms/${t.room.id}`);
    expect(room.debate?.status).toBe('interrupted'); expect(nextSdk.calls).toHaveLength(0); expect(room.members[0]!.status).toBe('interrupted');
    expect(room.debate?.terminalMessageId).toBeTruthy();
  });

  it('rejects concurrent starts and treats repeated request IDs as idempotent', async () => {
    const sdk = new TestOnlySdk(); const pending = gate(); sdk.holdNextDelivery(pending.promise); const t = await setup({ sdk });
    const results = await Promise.all([t.message('first'), t.message('second')]); expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const accepted = results[0]!.status === 200 ? 'first' : 'second'; expect((await t.message(accepted)).status).toBe(200);
    await request(t.server, `/rooms/${t.room.id}/debate/stop`, {}); pending.resolve();
  });

  it('validates round bounds and uses normal two-member routing when disabled', async () => {
    const t = await setup({ autoDebate: false });
    for (const maxRounds of [0, 11, 1.5, '2']) expect((await request(t.server, `/rooms/${t.room.id}`, { maxRounds }, 'PATCH')).status).toBe(400);
    const changed = await value<GroupRoomSnapshot>(t.server, `/rooms/${t.room.id}`, { maxRounds: 1, autoDebate: false }, 'PATCH'); expect(changed.maxRounds).toBe(1);
    await t.message(); await eventually(async () => expect((await t.current()).members.every(member => member.status === 'completed')).toBe(true));
    expect(t.sdk.calls).toHaveLength(2); expect((await t.current()).debate).toBeUndefined();
  });

  it('rejects malformed room settings and non-boolean autoReply as client errors', async () => {
    const t = await setup({ autoDebate: false });
    expect((await request(t.server, `/rooms/${t.room.id}`, 1, 'PATCH')).status).toBe(400);
    const created = await request(t.server, '/rooms', { requestId: crypto.randomUUID(), title: '错误开关', memberIds: t.agents.slice(0, 1).map(agent => agent.id), machineId: 'machine-1', directory: '/tmp/work', autoReply: 'yes' });
    expect(created.status).toBe(400);
  });
});
