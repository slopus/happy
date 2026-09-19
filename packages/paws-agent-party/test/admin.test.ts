import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AdminService } from '../src/server/admin.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it('keeps the default visitor allowance configurable and persists its owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paws-agent-party-admin-')); directories.push(directory);
  const first = await AdminService.create(directory);
  expect(first.dashboard().policy.tokenLimit).toBe(200_000);
  expect(await first.claimOrAuthorize('owner-a')).toBe(true);
  expect(await first.claimOrAuthorize('owner-b')).toBe(false);
  await first.updatePolicy({ enabled: true, tokenLimit: 50_000, allowImages: false, maxConcurrentVisitors: 8 });
  const visitor = await first.recordVisit();
  expect(visitor.policy).toEqual({ enabled: true, tokenLimit: 50_000, allowImages: false });
  const restored = await AdminService.create(directory);
  expect(restored.dashboard()).toMatchObject({ ownerAccountId: 'owner-a', visitors: { total: 1 }, policy: { enabled: true, tokenLimit: 50_000, maxConcurrentVisitors: 8 } });
});
