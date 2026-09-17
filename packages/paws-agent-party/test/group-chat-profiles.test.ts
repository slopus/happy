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
});
