import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_MODEL, ProfileService } from '../src/group-chat/profiles.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function createService(): Promise<ProfileService> {
  const dir = await mkdtemp(join(tmpdir(), 'paws-agent-party-profiles-'));
  dirs.push(dir);
  return ProfileService.create(dir);
}

describe('Codex group-chat profiles', () => {
  it('seeds all reusable profiles with the approved Codex launch defaults', async () => {
    const profiles = (await createService()).list();
    expect(profiles).toHaveLength(3);
    expect(profiles.map(profile => ({ engine: profile.engine, model: profile.model, effort: profile.effort }))).toEqual([
      { engine: 'codex', model: DEFAULT_CODEX_MODEL, effort: DEFAULT_CODEX_EFFORT },
      { engine: 'codex', model: DEFAULT_CODEX_MODEL, effort: DEFAULT_CODEX_EFFORT },
      { engine: 'codex', model: DEFAULT_CODEX_MODEL, effort: DEFAULT_CODEX_EFFORT },
    ]);
  });

  it('defaults new profiles to luna/low and rejects a non-Codex engine', async () => {
    const service = await createService();
    await expect(service.create({ name: '研究员', instructions: '核查来源。' })).resolves.toMatchObject({
      engine: 'codex', model: 'gpt-5.6-luna', effort: 'low',
    });
    await expect(service.create({ name: '旧 Agent', instructions: '不应创建。', engine: 'claude' })).rejects.toThrow('Codex Agent profiles only');
  });

  it('validates avatar and paired machine configuration while preserving legacy defaults', async () => {
    const service = await createService();
    await expect(service.create({ name: '远端研究员', instructions: '核查来源。', avatarId: 23, machineId: 'machine-2', directory: '/srv/repo' }))
      .resolves.toMatchObject({ avatarId: 23, machineId: 'machine-2', directory: '/srv/repo' });
    await expect(service.create({ name: '坏头像', instructions: '拒绝。', avatarId: 24 })).rejects.toThrow('avatarId');
    await expect(service.create({ name: '半配置', instructions: '拒绝。', machineId: 'machine-2' })).rejects.toThrow('machineId and directory');
    expect(service.list().find(profile => profile.name === '产品经理')).toMatchObject({ avatarId: 0 });
  });

  it('returns client errors for malformed optional configuration fields', async () => {
    const service = await createService();
    await expect(service.create({ name: '空头像', instructions: '拒绝', avatarId: null as never })).rejects.toMatchObject({ status: 400 });
    await expect(service.create({ name: '数字机器', instructions: '拒绝', machineId: 1 as never, directory: '/tmp' })).rejects.toMatchObject({ status: 400 });
    await expect(service.create({ name: '对象目录', instructions: '拒绝', machineId: 'machine', directory: {} as never })).rejects.toMatchObject({ status: 400 });
  });
});
