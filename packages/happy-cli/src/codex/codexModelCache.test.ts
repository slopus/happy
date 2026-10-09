import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexModelCache } from './codexModelCache';
const roots: string[] = [];
async function home() { const path = await mkdtemp(join(tmpdir(), 'paws-catalog-')); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const now = 1_790_000_000_000;
const data = (at = now, version = '0.159.3') => JSON.stringify({ fetched_at: new Date(at).toISOString(), client_version: version, etag: 'native', models: [{ slug: 'model-a' }] });
it('reuses only the matching account and profile, preserving native version, TTL and permissions', async () => {
 const root = await home(), source = await home(), target = await home();
 await writeFile(join(source, 'models_cache.json'), data());
 const cache = new CodexModelCache(root, 'profile', 'account');
 await cache.publish(source, now); await cache.restore(target, now + 1000);
 expect(await readFile(join(target, 'models_cache.json'), 'utf8')).toBe(data());
 expect((await stat(join(target, 'models_cache.json'))).mode & 0o777).toBe(0o600);
 for (const [profile, account] of [['profile', 'other'], ['other', 'account']]) {
  const isolated = await home(); await new CodexModelCache(root, profile, account).restore(isolated, now);
  expect(await readdir(isolated)).toEqual([]);
 }
 const expired = await home(); await cache.restore(expired, now + 300_000);
 expect(await readdir(expired)).toEqual([]);
});
it('concurrent and old writers cannot overwrite a newer native catalog', async () => {
 const root = await home(), old = await home(), fresh = await home(), target = await home();
 await writeFile(join(old, 'models_cache.json'), data(now - 1000));
 await writeFile(join(fresh, 'models_cache.json'), data(now, '0.160.0'));
 const cache = new CodexModelCache(root, 'p', 'a');
 await Promise.all([cache.publish(fresh, now), cache.publish(old, now), cache.publish(fresh, now)]);
 await cache.publish(old, now); await cache.restore(target, now);
 expect(await readFile(join(target, 'models_cache.json'), 'utf8')).toBe(data(now, '0.160.0'));
});
it('rejects corrupt, stale, future and oversized files and never follows a file symlink', async () => {
 for (const value of ['broken', data(now - 300_000), data(now + 1), JSON.stringify({models:[]}), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
  const root = await home(), source = await home(), target = await home();
  await writeFile(join(source, 'models_cache.json'), value);
  const cache = new CodexModelCache(root, 'p', 'a'); await cache.publish(source, now); await cache.restore(target, now);
  expect(await readdir(target)).toEqual([]);
 }
 const root = await home(), source = await home(), target = await home();
 await writeFile(join(root, 'private'), data()); await symlink(join(root, 'private'), join(source, 'models_cache.json'));
 const cache = new CodexModelCache(root, 'p', 'a'); await cache.publish(source, now); await cache.restore(target, now);
 expect(await readdir(target)).toEqual([]);
});
it('does not overwrite an existing target or its symlink', async () => {
 const root = await home(), source = await home(), target = await home();
 await writeFile(join(source, 'models_cache.json'), data());
 await writeFile(join(root, 'private'), 'leave alone'); await symlink(join(root, 'private'), join(target, 'models_cache.json'));
 const cache = new CodexModelCache(root, 'p', 'a'); await cache.publish(source, now); await cache.restore(target, now);
 expect(await readFile(join(root, 'private'), 'utf8')).toBe('leave alone');
});

it.skipIf(process.platform === 'win32')('treats a FIFO as a miss without waiting for a writer', async () => {
 const root = await home(), source = await home(), target = await home();
 execFileSync('mkfifo', [join(source, 'models_cache.json')]);
 const cache = new CodexModelCache(root, 'p', 'a'); await cache.publish(source, now); await cache.restore(target, now);
 expect(await readdir(target)).toEqual([]);
});
