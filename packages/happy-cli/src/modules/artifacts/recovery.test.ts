import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const faults = vi.hoisted(() => ({ failTarget: '', failCatalogAfterWorkingWrite: false, workingWritten: false, root: '', externalDuringStaging: false, partialStage: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[1] !== 'wx' || !String(args[0]).startsWith(faults.root)) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === 'writeFile') return async (data: Buffer) => {
          if (faults.partialStage) { await target.writeFile(data.subarray(0, 1)); throw new Error('ENOSPC'); }
          await target.writeFile(data);
          if (faults.externalDuringStaging) { faults.externalDuringStaging = false; await fs.writeFile(join(faults.root, 'a.md'), 'external during stage'); }
        };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const target = String(args[1]);
      if (target === faults.failTarget || (faults.failCatalogAfterWorkingWrite && faults.workingWritten && target.endsWith('catalog.json'))) throw new Error('ENOSPC');
      const result = await fs.rename(...args);
      if (target.startsWith(faults.root + '/')) faults.workingWritten = true;
      return result;
    },
  };
});
import { ArtifactStore } from './store';
let dir: string, root: string, storage: string;
const make = () => new ArtifactStore({ storage, accountScope: 'a'.repeat(64), inventory: async () => [] });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'paws-recovery-')); root = join(dir, 'project'); storage = join(dir, 'store'); await mkdir(root); root = await realpath(root); Object.assign(faults, { failTarget: '', failCatalogAfterWorkingWrite: false, workingWritten: false, externalDuringStaging: false, partialStage: false, root }); await writeFile(join(root, 'a.md'), 'old'); await writeFile(join(root, 'b.css'), 'old-css'); });
afterEach(async () => { Object.assign(faults, { failTarget: '', failCatalogAfterWorkingWrite: false, partialStage: false }); await rm(dir, { recursive: true, force: true }); });
async function setup() { const s = make(), a = await s.register({ root, entryPath: 'a.md', managedPaths: ['a.md', 'b.css'], operationId: 'register' }); const ref = { workspaceId: a.workspaceId, artifactId: a.id }; const read = await s.read(ref); return { s, a, ref, request: { ...ref, operationId: 'save', expectedRevision: read.workingRevision, entryContent: 'new', changes: [{ path: 'b.css', content: Buffer.from('new-css').toString('base64') }] } }; }
it('does not report success when working writes succeed but history commit fails; startup resumes the same intent', async () => {
  const { s, ref, request } = await setup(); faults.workingWritten = false; faults.failCatalogAfterWorkingWrite = true;
  await expect(s.save(request)).rejects.toMatchObject({ code: 'PARTIAL_COMMIT', operationId: 'save' });
  faults.failCatalogAfterWorkingWrite = false;
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('new');
  expect(await make().read(ref)).toMatchObject({ entryContent: 'old', workingState: 'recovery-required' });
  expect((await make().operation(ref.workspaceId, 'save')).status).toBe('pending');
  await make().recover();
  expect((await make().operation(ref.workspaceId, 'save')).status).toBe('committed');
  expect((await make().versions(ref)).versions).toHaveLength(2);
  expect((await make().save(request)).version.id).toBe((await make().versions(ref)).currentVersionId);
});
it('rolls back a multi-file partial commit without deleting unrelated files or history', async () => {
  const { s, ref, request } = await setup(); await writeFile(join(root, 'unowned'), 'keep'); faults.failTarget = join(root, 'b.css');
  await expect(s.save(request)).rejects.toMatchObject({ code: 'PARTIAL_COMMIT' }); faults.failTarget = '';
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('new');
  expect(await readFile(join(root, 'b.css'), 'utf8')).toBe('old-css');
  const op = await make().operation(ref.workspaceId, 'save');
  const resolve = { workspaceId: ref.workspaceId, operationId: 'save', resolutionId: 'rollback', action: 'rollback' as const, expectedObservedRevision: op.observedRevision };
  await make().resolveOperation(resolve); await make().resolveOperation(resolve);
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('old');
  expect(await readFile(join(root, 'unowned'), 'utf8')).toBe('keep');
  expect((await make().versions(ref)).versions).toHaveLength(1);
});
it('continues a partially applied capture rollback after restart with the original resolution identity', async () => {
  const { s, ref } = await setup();
  await s.beginTurn({directory:root,sessionId:'session',runId:'capture-retry',prompt:'edit'});
  await writeFile(join(root,'a.md'),Buffer.from([0xff])); await writeFile(join(root,'b.css'),'changed-css');
  await expect(s.finishTurn('capture-retry','completed')).rejects.toMatchObject({code:'COMMIT_PENDING'});
  const id='capture-capture-retry';let operation=await s.operation(ref.workspaceId,id);
  faults.failTarget=join(root,'b.css');
  await expect(s.resolveOperation({workspaceId:ref.workspaceId,operationId:id,resolutionId:'same-resolution',action:'rollback',expectedObservedRevision:operation.observedRevision})).rejects.toThrow();
  faults.failTarget=''; const reopened=make();await reopened.recover();operation=await reopened.operation(ref.workspaceId,id);
  await expect(reopened.resolveOperation({workspaceId:ref.workspaceId,operationId:id,resolutionId:'different-resolution',action:'rollback',expectedObservedRevision:operation.observedRevision})).rejects.toMatchObject({code:'CONFLICT'});
  await reopened.resolveOperation({workspaceId:ref.workspaceId,operationId:id,resolutionId:'same-resolution',action:'rollback',expectedObservedRevision:operation.observedRevision});
  expect(await readFile(join(root,'a.md'),'utf8')).toBe('old');expect(await readFile(join(root,'b.css'),'utf8')).toBe('old-css');expect((await reopened.read(ref)).workingState).toBe('clean');
});
it('refuses resume and rollback over a third, unrecorded image, including startup recovery', async () => {
  const { s, ref, request } = await setup(); faults.failTarget = join(root, 'b.css');
  await expect(s.save(request)).rejects.toMatchObject({ code: 'PARTIAL_COMMIT' }); faults.failTarget = '';
  await writeFile(join(root, 'a.md'), 'external'); await make().recover();
  const op = await make().operation(ref.workspaceId, 'save'); expect(op.actions).toEqual([]);
  for (const action of ['resume', 'rollback'] as const) await expect(make().resolveOperation({ workspaceId: ref.workspaceId, operationId: 'save', resolutionId: action, action, expectedObservedRevision: op.observedRevision })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('external');
});
it('rechecks the preimage after staging and removes failed temporary files', async () => {
  const { s, ref, request } = await setup(); faults.externalDuringStaging = true;
  await expect(s.save(request)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('external during stage');
  expect((await make().operation(ref.workspaceId, 'save')).status).toBe('pending');
  expect((await readdir(root)).filter(p => p.endsWith('.tmp'))).toEqual([]);
});
it('cleans an incomplete staged file while retaining its recoverable intent', async () => {
  const { s, request } = await setup(); faults.partialStage = true;
  await expect(s.save(request)).rejects.toMatchObject({ code: 'PARTIAL_COMMIT' }); faults.partialStage = false;
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('old');
  expect((await readdir(root)).filter(p => p.endsWith('.tmp'))).toEqual([]);
});


it('returns the generated operation ID through the encrypted legacy save error', async () => {
  const { s, ref } = await setup();
  const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
  const { registerCommonHandlers } = await import('@/modules/common/registerCommonHandlers');
  const { encrypt, decrypt, encodeBase64, decodeBase64 } = await import('@/api/encryption');
  const key = new Uint8Array(32).fill(7);
  const manager = new RpcHandlerManager({ scopePrefix: 'legacy', encryptionKey: key, encryptionVariant: 'legacy', logger: () => {} });
  registerCommonHandlers(manager, root, async () => s);
  const hash = (await s.read(ref)).manifest.files.find(f => f.path === 'a.md')!.sha256;
  faults.workingWritten = false; faults.failCatalogAfterWorkingWrite = true;
  const result: any = decrypt(key, 'legacy', decodeBase64(await manager.handleRequest({ method: 'legacy:writeFile', params: encodeBase64(encrypt(key, 'legacy', { path: 'a.md', content: Buffer.from('saved').toString('base64'), expectedHash: hash })) })));
  faults.failCatalogAfterWorkingWrite = false;
  expect(result).toMatchObject({ success: false, code: 'PARTIAL_COMMIT', operationId: expect.any(String) });
  expect((await s.operation(ref.workspaceId, result.operationId)).status).toBe('pending');
});
