import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    create: async () => 'party-1', createGroup: async () => 'party-1', read: async () => [],
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
