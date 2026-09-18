import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetStore } from '../src/server/assets.js';
import type { PartyBus } from '../src/server/party.js';
import { ProfileService } from '../src/group-chat/profiles.js';
import { GroupRoomService } from '../src/group-chat/rooms.js';
import { TestOnlySdk } from './fake-sdk.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

function party(failTerminal: boolean, calls: string[]): PartyBus {
  return {
    create: async () => 'party-1', createGroup: async () => 'party-1', join: async () => undefined, delete: async () => undefined, read: async () => [],
    send: async input => {
      calls.push(input.text);
      if (failTerminal && input.text.startsWith('辩论已')) throw new Error('party temporarily unavailable');
      return { id: `message-${calls.length}` } as never;
    },
  };
}

describe('durable debate terminal announcements', () => {
  it('does not fail startup when a terminal announcement cannot be sent, and retries it after restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-debate-terminal-')); dirs.push(dataDir);
    await writeFile(join(dataDir, 'group-chat-rooms.json'), JSON.stringify({ rooms: [{ snapshot: {
      id: 'room-1', partyId: 'party-1', title: '已结束的讨论', machineId: 'machine-1', directory: '/tmp/work', autoReply: true, autoDebate: true, maxRounds: 1, createdAt: 1, updatedAt: 1,
      members: [{ id: 'agent-a', name: '甲', instructions: '立论', engine: 'codex', model: 'gpt-5.6-luna', effort: 'low', status: 'completed' }], turns: [],
      debate: { id: 'debate-1', status: 'completed', members: ['agent-a', 'agent-b'], maxRounds: 1, completedRounds: 1, completedTurns: 2, currentTurn: 2, nextMemberId: null, sourceMessageId: 'source-1' },
    }, cursors: {} }], requestIds: {}, messageRequestIds: [] }));
    const profiles = await ProfileService.create(dataDir); const assets = new AssetStore(dataDir); const calls: string[] = [];
    const first = await GroupRoomService.create({ dataDir, sdk: new TestOnlySdk() as never, assets, party: party(true, calls), profiles });
    expect(calls).toEqual(['辩论已在第 1 / 1 轮结束']);
    expect(first.get('room-1').debate?.terminalMessageId).toBeUndefined();
    await first.close();
    const second = await GroupRoomService.create({ dataDir, sdk: new TestOnlySdk() as never, assets, party: party(false, calls), profiles });
    expect(calls).toEqual(['辩论已在第 1 / 1 轮结束', '辩论已在第 1 / 1 轮结束']);
    expect(second.get('room-1').debate?.terminalMessageId).toBeTruthy();
    await second.close();
  });
});

describe('durable room deletion', () => {
  it('persists a tombstone before Party deletion and replays unfinished cleanup after restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-room-delete-')); dirs.push(dataDir);
    const profiles = await ProfileService.create(dataDir); const assets = new AssetStore(dataDir); const calls: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const bus = party(false, calls); bus.delete = async () => gate;
    const service = await GroupRoomService.create({ dataDir, sdk: new TestOnlySdk() as never, assets, party: bus, profiles });
    const room = await service.create({ requestId: 'create-delete', title: '删除恢复', memberIds: [profiles.list()[0]!.id], machineId: 'machine-1', directory: '/tmp/work' });
    const pending = service.delete(room.id);
    await eventually(async () => {
      const stored = JSON.parse(await readFile(join(dataDir, 'group-chat-rooms.json'), 'utf8'));
      expect(stored.rooms).toHaveLength(0); expect(stored.deletions).toEqual([{ roomId: room.id, partyId: room.partyId }]);
    });
    release(); await pending; await service.close();
    const interrupted = JSON.parse(await readFile(join(dataDir, 'group-chat-rooms.json'), 'utf8'));
    interrupted.deletions = [{ roomId: room.id, partyId: room.partyId }];
    await writeFile(join(dataDir, 'group-chat-rooms.json'), JSON.stringify(interrupted));
    let replayed = 0; const replayBus = party(false, []); replayBus.delete = async () => { replayed += 1; };
    const reopened = await GroupRoomService.create({ dataDir, sdk: new TestOnlySdk() as never, assets, party: replayBus, profiles });
    expect(replayed).toBe(1); expect(reopened.list()).toHaveLength(0);
    expect(JSON.parse(await readFile(join(dataDir, 'group-chat-rooms.json'), 'utf8')).deletions).toEqual([]);
    await reopened.close();
  });

  it('rejects deletion while a terminal debate job is still publishing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-room-debate-delete-')); dirs.push(dataDir);
    const profiles = await ProfileService.create(dataDir); const assets = new AssetStore(dataDir); const sdk = new TestOnlySdk();
    let release!: () => void; const terminalGate = new Promise<void>(resolve => { release = resolve; }); let sequence = 0;
    const bus = party(false, []); bus.send = async input => {
      if (input.text.startsWith('辩论已')) await terminalGate;
      return { id: `message-${++sequence}`, cursor: String(sequence), kind: 'message', from: input.from, to: input.to, text: input.text, createdAt: Date.now() } as never;
    };
    const service = await GroupRoomService.create({ dataDir, sdk: sdk as never, assets, party: bus, profiles });
    const members = profiles.list().slice(0, 2); const room = await service.create({ requestId: 'debate-delete', title: '终局', memberIds: members.map(member => member.id), machineId: 'machine-1', directory: '/tmp/work', autoDebate: true, maxRounds: 1 });
    await service.message(room.id, { requestId: 'debate-message', text: members.map(member => `@${member.name}`).join(' '), images: [] });
    await eventually(() => expect(service.get(room.id).debate?.status).toBe('completed'));
    await expect(service.delete(room.id)).rejects.toMatchObject({ status: 409 });
    release(); await eventually(() => expect(service.get(room.id).debate?.terminalMessageId).toBeTruthy());
    await eventually(() => service.delete(room.id)); await service.close();
  });

  it('retries Party cleanup from the tombstone without resurrecting the room', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-room-delete-retry-')); dirs.push(dataDir);
    const profiles = await ProfileService.create(dataDir); const assets = new AssetStore(dataDir); const bus = party(false, []); let attempts = 0;
    bus.delete = async () => { attempts += 1; if (attempts === 1) throw new Error('temporary delete failure'); };
    const service = await GroupRoomService.create({ dataDir, sdk: new TestOnlySdk() as never, assets, party: bus, profiles });
    const room = await service.create({ requestId: 'delete-retry', title: '重试', memberIds: [profiles.list()[0]!.id], machineId: 'machine-1', directory: '/tmp/work' });
    await expect(service.delete(room.id)).rejects.toThrow('temporary delete failure');
    expect(service.list()).toHaveLength(0);
    await expect(service.delete(room.id)).resolves.toBeUndefined(); expect(attempts).toBe(2);
    await service.close();
  });

  it('does not delete Party until a failed tombstone write succeeds on retry', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paws-room-delete-persist-retry-')); dirs.push(dataDir);
    const profiles = await ProfileService.create(dataDir); const assets = new AssetStore(dataDir); const bus = party(false, []); let partyDeletes = 0;
    bus.delete = async () => { partyDeletes += 1; };
    const service = await GroupRoomService.create({ dataDir, sdk: new TestOnlySdk() as never, assets, party: bus, profiles });
    const room = await service.create({ requestId: 'delete-persist-retry', title: '落盘重试', memberIds: [profiles.list()[0]!.id], machineId: 'machine-1', directory: '/tmp/work' });
    const mutable = service as unknown as { persist: () => Promise<void>; persistQueue: Promise<void> }; const persist = mutable.persist.bind(service); let fail = true;
    mutable.persist = async () => { if (fail) { fail = false; const rejected = Promise.reject(new Error('injected first tombstone write failure')); mutable.persistQueue = rejected; return rejected; } await persist(); };
    await expect(service.delete(room.id)).rejects.toThrow('injected first tombstone write failure');
    expect(partyDeletes).toBe(0);
    expect(JSON.parse(await readFile(join(dataDir, 'group-chat-rooms.json'), 'utf8')).rooms).toHaveLength(1);
    await service.delete(room.id); expect(partyDeletes).toBe(1); await service.close();
    const reopened = await GroupRoomService.create({ dataDir, sdk: new TestOnlySdk() as never, assets, party: party(false, []), profiles });
    expect(reopened.list()).toHaveLength(0); await reopened.close();
  });
});

async function eventually(assertion: () => void | Promise<void>): Promise<void> { let last: unknown; for (let i = 0; i < 30; i += 1) { try { await assertion(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 10)); } } throw last; }
