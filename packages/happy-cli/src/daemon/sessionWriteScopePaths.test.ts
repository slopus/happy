import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeSessionWriteRoot } from './sessionWriteScopePaths';

const fixtures: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'write-scope-')); fixtures.push(home);
  const root = join(home, '.local', 'tools'); await mkdir(root, { recursive: true });
  const protectedRoot = join(home, '.ssh'); await mkdir(protectedRoot);
  return { home, root, protectedRoot, input: { home, protectedRoots: [protectedRoot] } };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('narrow write root', () => {
  it('rejects home/root, broad ancestors, relative paths and credential roots', async () => {
    const f = await fixture();
    for (const path of ['/', f.home, join(f.home, '.local'), f.protectedRoot, join(f.protectedRoot, 'new'), '../tools']) {
      await expect(canonicalizeSessionWriteRoot(path, f.input)).rejects.toThrow();
    }
  });
  it('records actual existing parent and refuses symlink substitution before application', async () => {
    const f = await fixture();
    const target = join(f.root, 'new', 'bin');
    const inspected = await canonicalizeSessionWriteRoot(target, f.input);
    expect(inspected.root).toBe(await (await import('node:fs/promises')).realpath(f.root));
    const original = inspected.identity;
    await rm(f.root, { recursive: true }); await symlink(f.protectedRoot, f.root);
    await expect(canonicalizeSessionWriteRoot(target, f.input)).rejects.toThrow();
    expect(original).toMatch(/^\d+:\d+$/);
  });
  it('refuses granting a parent containing a protected store', async () => {
    const f = await fixture(); const protectedRoot = join(f.root, 'keys'); await mkdir(protectedRoot);
    await expect(canonicalizeSessionWriteRoot(f.root, { ...f.input, protectedRoots: [protectedRoot] })).rejects.toThrow();
  });
  it('protects a future keyring under a symlinked parent before the store exists', async () => {
    const f = await fixture();
    await symlink(f.root, join(f.home, '.local', 'share'));
    await expect(canonicalizeSessionWriteRoot(f.root, f.input)).rejects.toThrow('PROTECTED_WRITE_ROOT');
  });
  it('canonicalizes missing protected suffixes and rejects dangling protected aliases', async () => {
    const f = await fixture();
    await symlink(f.protectedRoot, join(f.home, 'alias'));
    const protectedPath = join(f.home, 'alias', 'missing', 'keys');
    const inspected = await canonicalizeSessionWriteRoot(f.root, { ...f.input, protectedRoots: [protectedPath] });
    expect(inspected.floor).toContain(join(await realpath(f.protectedRoot), 'missing', 'keys'));
    expect(inspected.floor).not.toContain(protectedPath);
    await symlink(join(f.home, 'absent'), join(f.home, 'dangling'));
    await expect(canonicalizeSessionWriteRoot(f.root, { ...f.input, protectedRoots: [join(f.home, 'dangling', 'keys')] })).rejects.toThrow();
  });
});
