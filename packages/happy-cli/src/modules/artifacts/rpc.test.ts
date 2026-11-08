import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import { ArtifactStore } from './store';
import { registerArtifactHandlers } from './rpc';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
it('serves durable versions over both encrypted variants, with bounded requests and session scope checks', async () => {
  for (const variant of ['dataKey', 'legacy'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'paws-artifact-rpc-')); dirs.push(dir); const root = join(dir, 'project'); await mkdir(root); await writeFile(join(root, 'a.md'), 'first');
    const key = randomBytes(32), store = new ArtifactStore({ storage: join(dir, 'store'), accountScope: 'a'.repeat(64), inventory: async () => [] });
    const manager = new RpcHandlerManager({ scopePrefix: 'test', encryptionKey: key, encryptionVariant: variant, logger: () => {} });
    registerArtifactHandlers(manager, async () => store, root);
    const call = async (method: string, input: unknown): Promise<any> => decrypt(key, variant, decodeBase64(await manager.handleRequest({ method: `test:${method}`, params: encodeBase64(encrypt(key, variant, input)) })));
    expect(await call('artifactCapabilities', {})).toMatchObject({ ok: true, value: { protocol: 2, formats: ['html', 'markdown'] } });
    const reg = await call('artifactRegister', { root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' }); expect(reg.ok).toBe(true);
    const alias=join(dir,'alias'); await symlink(root,alias);
    expect((await call('artifactCatalog',{root:alias+'/'})).value[0].artifacts[0].id).toBe(reg.value.id);
    const ref = { workspaceId: reg.value.workspaceId, artifactId: reg.value.id };
    const read = await call('artifactRead', ref);
    const saved = await call('artifactSave', { ...ref, operationId: 'save', expectedRevision: read.value.workingRevision, entryContent: 'second' });
    expect(saved.ok).toBe(true);
    expect((await call('artifactVersions', ref)).value.versions).toHaveLength(2);
    expect((await call('artifactRead', { ...ref, versionId: reg.value.currentVersionId })).value.entryContent).toBe('first');
    expect(await call('artifactResourceRead', { ...ref, readRef: read.value.readRef, path: 'a.md', offset: 0, length: 256 * 1024 + 1 })).toMatchObject({ ok: false });
    expect(await call('artifactRegister', { root: dir, entryPath: 'project/a.md', managedPaths: ['project/a.md'], operationId: 'escape' })).toMatchObject({ ok: false, error: { code: 'PATH_OUT_OF_BOUNDS' } });
  }
});

it('waits for lock-release events when current, history and frozen preview resources are requested together',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paws-concurrent-preview-'));dirs.push(dir);const root=join(dir,'project');await mkdir(root);await writeFile(join(root,'index.html'),'<link href="style.css">');await writeFile(join(root,'style.css'),'body{color:red}');
 const store=new ArtifactStore({storage:join(dir,'store'),accountScope:'a'.repeat(64),inventory:async()=>[]});const a=await store.register({root,entryPath:'index.html',managedPaths:['index.html','style.css'],operationId:'r'});const ref={workspaceId:a.workspaceId,artifactId:a.id};const current=await store.read(ref);
 const results=await Promise.all([store.read(ref),store.versions(ref),...Array.from({length:4},()=>store.resource({...ref,readRef:current.readRef,path:'style.css',offset:0,length:100}))]);expect(results).toHaveLength(6);
});
