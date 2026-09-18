import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { AccountAccess } from '../src/server/account-access.js';

beforeAll(async () => { await promisify(execFile)(process.execPath, ['scripts/build-server.mjs']); }, 20000);

it('migrates only to the verified explicit owner, refuses live writers and never overwrites a space', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'party-migration-'));
  const relay = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'owner-A' })); });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const dataDir = join(dir, 'legacy'); const tokenFile = join(dir, 'token');
  await mkdir(join(dataDir, 'assets'), { recursive: true });
  await writeFile(tokenFile, 'test-only'); await writeFile(join(dataDir, 'assets', 'image'), 'private image');
  await writeFile(join(dataDir, 'group-chat-rooms.json'), '{"rooms":[]}');
  await writeFile(join(dataDir, 'access-token'), 'must-not-copy');
  const run = (accountId: string) => promisify(execFile)(process.execPath, ['scripts/migrate-legacy-space.mjs', '--data-dir', dataDir, '--token-file', tokenFile, '--account-id', accountId], { env: { ...process.env, PAWS_AGENT_PARTY_RELAY_URL: serverUrl } });
  const target = join(dataDir, 'accounts', new AccountAccess(serverUrl, 'unused').tenantKey('owner-A'));
  try {
    await expect(run('owner-B')).rejects.toThrow();
    await writeFile(join(dataDir, 'service.lock'), 'live-owner');
    await expect(run('owner-A')).rejects.toThrow();
    expect(await readFile(join(dataDir, 'service.lock'), 'utf8')).toBe('live-owner');
    await rm(join(dataDir, 'service.lock'));
    await expect(run('owner-A')).resolves.toMatchObject({ stdout: expect.stringContaining('"migrated":true') });
    expect(await readFile(join(target, 'assets', 'image'), 'utf8')).toBe('private image');
    expect(await readFile(join(dataDir, 'assets', 'image'), 'utf8')).toBe('private image');
    await expect(readFile(join(target, 'access-token'))).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(join(target, 'legacy-migration.json'), 'utf8'));
    expect(manifest.accountId).toBe('owner-A'); expect(Object.keys(manifest.files)).toHaveLength(2);
    await expect(run('owner-A')).rejects.toThrow();
  } finally { await new Promise<void>(resolve => relay.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}, 20000);
