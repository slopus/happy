import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from './store';
import { runArtifactTurn } from './turn';
import { createWorkspaceFileHandlers } from '@/modules/common/workspaceFiles';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
it('captures only successful runner modifications and routes supported Task 2 saves into the same history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paws-runner-')); dirs.push(dir); const root = join(dir, 'project'); await mkdir(root); await writeFile(join(root, 'a.md'), 'baseline');
  const store = new ArtifactStore({ storage: join(dir, 'store'), accountScope: 'a'.repeat(64), inventory: async () => [] });
  const a = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' }), ref = { workspaceId: a.workspaceId, artifactId: a.id };
  const run = { directory: root, sessionId: 'session', prompt: 'user request' };
  await runArtifactTurn(store, run, async () => { await writeFile(join(root, 'a.md'), 'AI'); return { aborted: false }; });
  const files = createWorkspaceFileHandlers(root, async () => store), read = await files.read({ path: 'a.md' });
  if (!read.success) throw new Error(read.error);
  expect(await files.write({ path: 'a.md', expectedHash: read.hash, content: Buffer.from('manual').toString('base64') })).toMatchObject({ success: true });
  expect((await store.versions(ref)).versions.map(v => v.source)).toEqual(['manual', 'ai', 'baseline']);
  await expect(runArtifactTurn(store, run, async () => { await writeFile(join(root, 'a.md'), 'partial'); throw new Error('runner failed'); })).rejects.toThrow('runner failed');
  expect((await store.versions(ref)).versions).toHaveLength(3);
  expect((await store.read(ref)).workingState).toBe('dirty');
  await expect(store.assertUnmanagedRunner(root)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('partial');
});

it('retains the original user request while enforcing the Task 2 file-reference hash before execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paws-reference-')); dirs.push(dir); const root = join(dir, 'project'); await mkdir(root); await writeFile(join(root, 'a.md'), 'old');
  const store = new ArtifactStore({ storage: join(dir, 'store'), accountScope: 'a'.repeat(64), inventory: async () => [] });
  const a = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' }), ref = { workspaceId: a.workspaceId, artifactId: a.id };
  const hash = (await store.read(ref)).manifest.files[0].sha256;
  const prompt = '修改标题\n\n[Workspace file context]\n' + JSON.stringify({ path: 'a.md', hash }) + '\nRe-read the file.';
  await runArtifactTurn(store, { directory: root, sessionId: 's', prompt }, async () => { await writeFile(join(root, 'a.md'), 'new'); return { aborted: false }; });
  expect((await store.versions(ref)).versions[0].prompt).toBe('修改标题');
  let ran = false;
  await expect(runArtifactTurn(store, { directory: root, sessionId: 's', prompt }, async () => { ran = true; return { aborted: false }; })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(ran).toBe(false);
});

it('denies managed scope for shared or attached native execution and prevents a racing registration', async () => {
  const { prepareCodexArtifactScope } = await import('./turn');
  const dir = await mkdtemp(join(tmpdir(), 'paws-native-scope-')); dirs.push(dir); const root = join(dir, 'project'); await mkdir(root); await writeFile(join(root, 'a.md'), 'baseline');
  const store = new ArtifactStore({ storage: join(dir, 'store'), accountScope: 'a'.repeat(64), inventory: async () => [] });
  await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' });
  for (const mode of [{ connection: 'unixSocket' as const, attached: false }, { connection: 'spawn' as const, attached: true }]) {
    await expect(prepareCodexArtifactScope(mode, () => store.assertUnmanagedRunner(root))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  }
  const other = join(dir, 'unmanaged'); await mkdir(other); await writeFile(join(other, 'a.md'), 'other');
  expect(await prepareCodexArtifactScope({ connection: 'unixSocket', attached: false }, () => store.assertUnmanagedRunner(other))).toBe(false);
  await expect(store.register({ root: other, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'racing' })).rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
});

it('rejects a stale artifact revision even when only a dependency changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paws-version-reference-')); dirs.push(dir); const root=join(dir,'project'); await mkdir(root); await writeFile(join(root,'a.html'),'<link href="style.css">'); await writeFile(join(root,'style.css'),'old');
  const store=new ArtifactStore({storage:join(dir,'store'),accountScope:'a'.repeat(64),inventory:async()=>[]});
  const a=await store.register({root,entryPath:'a.html',managedPaths:['a.html','style.css'],operationId:'register'}); const current=await store.read({workspaceId:a.workspaceId,artifactId:a.id});
  const entry=current.manifest.files.find(f=>f.path==='a.html')!;
  await writeFile(join(root,'style.css'),'changed'); let ran=false;
  const prompt='Edit heading\n\n[Workspace file context]\n'+JSON.stringify({path:'a.html',hash:entry.sha256,artifact:{workspaceId:a.workspaceId,artifactId:a.id,expectedRevision:current.workingRevision}})+'\nRe-read';
  await expect(runArtifactTurn(store,{directory:root,sessionId:'s',prompt},async()=>{ran=true;return {aborted:false};})).rejects.toMatchObject({code:'CONFLICT'});
  expect(ran).toBe(false);
});
