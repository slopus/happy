import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountAccess } from '../src/server/account-access.js';
import { createAccountServer } from '../src/server/account-server.js';
import { TestOnlySdk } from './fake-sdk.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
it('isolates profiles, rooms and image reads, forbids shared-token and account-switch routes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'party-accounts-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const access = new AccountAccess('http://relay.test', 'master', async (_url, init) => {
    const token = new Headers(init?.headers).get('authorization')?.slice(7);
    return token === 'A' || token === 'B' ? Response.json({ id: token }) : new Response('', { status: 401 });
  });
  vi.spyOn(access, 'credentials').mockImplementation(async () => ({ token: 'fixture', secret: new Uint8Array(32), contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) } }));
  const server = await createAccountServer({ dataDir: dir, masterKey: 'master', serverUrl: 'http://relay.test', staticDir: dir, access, sdkFactory: () => new TestOnlySdk() });
  cleanups.push(() => server.close());
  const api = (path: string, token: string, method = 'GET', value?: unknown) => fetch(server.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
  const login = async (pawsToken: string) => {
    const ticketResponse = await api('/api/access/ticket', pawsToken, 'POST', { secret: 'fixture' });
    expect(ticketResponse.status).toBe(200);
    const ticket = (await ticketResponse.json()).ticket;
    return (await (await api('/api/access/exchange', '', 'POST', { ticket })).json()).token as string;
  };
  const a = await login('A'), b = await login('B');
  expect((await api('/api/group-chat/agents', 'master')).status).toBe(401);
  const created = await api('/api/group-chat/agents', a, 'POST', { name: 'Private A', instructions: 'Only A', model: 'gpt-5.6-luna', effort: 'low' });
  expect(created.status).toBeLessThan(300);
  const agentsB = await (await api('/api/group-chat/agents', b)).json();
  expect(JSON.stringify(agentsB)).not.toContain('Private A');
  const agentsA = await (await api('/api/group-chat/agents', a)).json();
  const privateId = agentsA.agents.find((item: { name: string }) => item.name === 'Private A').id;
  expect((await api(`/api/group-chat/agents/${privateId}`, b, 'PATCH', { name: 'stolen', instructions: 'no' })).status).toBe(404);
  // Paws manager and independent website have separate sessions, one catalog.
  const otherDeviceA = await login('A');
  expect((await api(`/api/group-chat/agents/${privateId}`, otherDeviceA, 'PATCH', { name: 'Private A', instructions: 'Edited from Paws mobile', avatarId: 12, machineId: 'machine-1', directory: '/tmp' })).status).toBe(200);
  const refreshed = await (await api('/api/group-chat/agents', a)).json();
  expect(refreshed.agents.find((item: { id: string }) => item.id === privateId)).toMatchObject({ instructions: 'Edited from Paws mobile', avatarId: 12, machineId: 'machine-1', directory: '/tmp' });
  const roomResponse = await api('/api/group-chat/rooms', a, 'POST', { requestId: 'private-room', title: 'Only A room', memberIds: [privateId], machineId: 'machine-1', directory: '/tmp' });
  expect(roomResponse.status).toBeLessThan(300);
  const room = await roomResponse.json();
  expect((await api(`/api/group-chat/rooms/${room.id}`, b)).status).toBe(404);
  expect((await api(`/api/group-chat/rooms/${room.id}/events`, b)).status).toBe(404);
  expect(JSON.stringify(await (await api('/api/group-chat/rooms', b)).json())).not.toContain('Only A room');
  const imageResponse = await fetch(server.url + '/api/assets', { method: 'POST', headers: { authorization: `Bearer ${a}`, 'content-type': 'image/png', 'x-filename': 'private.png' }, body: new Uint8Array([1, 2, 3]) });
  expect(imageResponse.status).toBeLessThan(300);
  const image = await imageResponse.json();
  expect((await api(`/api/assets/${image.id}`, a)).status).toBe(200);
  expect((await api(`/api/assets/${image.id}`, b)).status).toBe(404);
  const stream = await api(`/api/group-chat/rooms/${room.id}/events`, a);
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  await reader.read();
  for (const token of [a, b]) {
    expect((await api('/api/paws/recover', token, 'POST', { serverUrl: 'http://evil', recoveryCode: 'anything' })).status).toBe(403);
    expect((await api('/api/paws/link', token, 'POST', { serverUrl: 'http://evil' })).status).toBe(403);
  }
  expect((await api('/api/access/logout', a, 'POST')).status).toBe(200);
  await expect(reader.read()).rejects.toThrow();
  expect((await api('/api/group-chat/rooms', a)).status).toBe(401);
  expect((await api('/api/group-chat/rooms', b)).status).toBe(200);
});
