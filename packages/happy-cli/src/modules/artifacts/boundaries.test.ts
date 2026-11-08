import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from './store';
let dir: string, root: string, storage: string;
const make = (scope = 'a') => new ArtifactStore({ storage, accountScope: scope.repeat(64), inventory: async () => [] });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'paws-artifact-scope-')); root = join(dir, 'project'); storage = join(dir, 'store'); await mkdir(root); await writeFile(join(root, 'a.md'), '# baseline'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function setup() { const store = make(), a = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' }); const ref = { workspaceId: a.workspaceId, artifactId: a.id }; return { store, a, ref }; }
it('keeps stable identity through rename and reads/restores pre-rename history', async () => {
  const { store, a, ref } = await setup();
  const renamed = await store.rename({ ...ref, operationId: 'rename', expectedRevision: (await store.read(ref)).workingRevision, nextName: 'renamed', nextEntryPath: 'b.md' });
  expect((await store.read(ref)).artifact.id).toBe(a.id);
  expect((await store.read({ ...ref, versionId: a.currentVersionId })).manifest.entryPath).toBe('a.md');
  await store.restore({ ...ref, operationId: 'restore', expectedRevision: renamed.workingRevision, versionId: a.currentVersionId });
  expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('# baseline');
  await expect(readFile(join(root, 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('isolates accounts, rejects overlapping ownership and mismatched mutation IDs', async () => {
  const { store, ref } = await setup();
  await expect(make('b').read(ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(make('b').register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' })).rejects.toMatchObject({ code: 'CONFLICT' });
  await writeFile(join(root, 'b.html'), '<p>x</p>');
  await expect(store.register({ root, entryPath: 'b.html', managedPaths: ['b.html', 'a.md'], operationId: 'second' })).rejects.toMatchObject({ code: 'CONFLICT' });
  const request = { ...ref, operationId: 'save', expectedRevision: (await store.read(ref)).workingRevision, entryContent: 'new' };
  await store.save(request);
  await expect(store.save({ ...request, entryContent: 'different' })).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('rejects traversal, symlinks, hardlinks and case aliases without touching their targets', async () => {
  await writeFile(join(dir, 'secret.md'), 'secret'); await symlink(join(dir, 'secret.md'), join(root, 'escape.md')); await link(join(root, 'a.md'), join(root, 'hard.md'));
  for (const path of ['../secret.md', 'escape.md', 'hard.md']) await expect(make().register({ root, entryPath: path, managedPaths: [path], operationId: 'register' })).rejects.toMatchObject({ code: 'PATH_OUT_OF_BOUNDS' });
  expect(await readFile(join(dir, 'secret.md'), 'utf8')).toBe('secret');
});
it('reports missing historical objects and never substitutes the current dependency', async () => {
  const { store, a, ref } = await setup(), selected = await store.read(ref);
  await unlink(join(storage, 'a'.repeat(64), 'objects', selected.manifest.files[0].sha256));
  await writeFile(join(root, 'a.md'), 'different');
  await expect(store.read({ ...ref, versionId: a.currentVersionId })).rejects.toMatchObject({ code: 'INCOMPLETE_VERSION' });
});
it('enforces byte limits without truncation and preserves owner-only index permissions', async () => {
  const { store, ref } = await setup();
  const revision = (await store.read(ref)).workingRevision;
  await expect(store.save({ ...ref, operationId: 'large', expectedRevision: revision, entryContent: '汉'.repeat(750000) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# baseline');
  expect((await stat(join(storage, 'catalog.json'))).mode & 0o777).toBe(0o600);
});
it('requires revision-aware v2 workers while retaining readable historical data',async()=>{
 let protocol=2;const store=new ArtifactStore({storage,accountScope:'a'.repeat(64),inventory:async()=>[{pid:process.pid,directory:root,protocol}]});
 const a=await store.register({root,entryPath:'a.md',managedPaths:['a.md'],operationId:'new'}), ref={workspaceId:a.workspaceId,artifactId:a.id};const current=await store.read(ref);protocol=1;
 expect((await store.read({...ref,versionId:a.currentVersionId})).entryContent).toBe('# baseline');
 await expect(store.save({...ref,operationId:'old-worker',expectedRevision:current.workingRevision,entryContent:'unsafe'})).rejects.toMatchObject({code:'UNAVAILABLE'});expect(await readFile(join(root,'a.md'),'utf8')).toBe('# baseline');
});
