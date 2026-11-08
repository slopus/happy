import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ArtifactStore } from './store';
import { runArtifactTurn } from './turn';
import { withMachineLock } from './files';
import { registerCommonHandlers } from '@/modules/common/registerCommonHandlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
let directory: string, root: string, storage: string;
const make = (account = 'a') => new ArtifactStore({ storage, accountScope: account.repeat(64), inventory: async () => [] });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'paws-review-fixes-')); root = join(directory, 'project'); storage = join(directory, 'store'); await mkdir(root); await writeFile(join(root, 'a.md'), 'baseline'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function registered() { const store = make(), artifact = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md', 'missing.css'], operationId: 'register' }); return { store, artifact, ref: { workspaceId: artifact.workspaceId, artifactId: artifact.id } }; }
async function failedCapture(remove = true) { const t = await registered(); await t.store.beginTurn({ directory: root, sessionId: 'session', runId: 'run', prompt: 'edit' }); if (remove) await unlink(join(root, 'a.md')); else await writeFile(join(root, 'a.md'), Buffer.from([0xff])); await expect(t.store.finishTurn('run', 'completed')).rejects.toMatchObject({ code: 'COMMIT_PENDING' }); return t; }

it('rejects third-party bytes written after capture rollback revision validation', async () => {
  const t = await failedCapture(false), op = await t.store.operation(t.artifact.workspaceId, 'capture-run');
  // Observe the real durability boundary; every production write still runs.
  type PersistBoundary = { persist(db: { workspaces: Array<{ captureFailure?: { resolution?: unknown } }> }): Promise<void> };
  const boundary = t.store as unknown as PersistBoundary, persist = boundary.persist.bind(t.store); let injected = false;
  boundary.persist = async db => {
    await persist(db);
    if (!injected && db.workspaces[0].captureFailure?.resolution) { injected = true; await writeFile(join(root, 'a.md'), 'THIRD PARTY CHANGE'); }
  };
  await expect(t.store.resolveOperation({ workspaceId: t.artifact.workspaceId, operationId: 'capture-run', resolutionId: 'rollback', action: 'rollback', expectedObservedRevision: op.observedRevision })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('THIRD PARTY CHANGE');
  expect((await t.store.versions(t.ref)).versions).toHaveLength(1);
});

it('routes missing legacy targets through real-parent ownership and writer checks', async () => {
  const t = await registered(), caller = join(directory, 'caller'); await mkdir(caller); await symlink(root, join(caller, 'alias'));
  await t.store.beginTurn({ directory: root, sessionId: 'session', runId: 'active', prompt: 'edit' });
  const call = async (store: ArtifactStore, path: string) => {
    const key = randomBytes(32), manager = new RpcHandlerManager({ scopePrefix: 'legacy', encryptionKey: key, encryptionVariant: 'dataKey', logger: () => {} });
    registerCommonHandlers(manager, caller, async () => store);
    return decrypt(key, 'dataKey', decodeBase64(await manager.handleRequest({ method: 'legacy:writeFile', params: encodeBase64(encrypt(key, 'dataKey', { path, content: Buffer.from('new').toString('base64'), expectedHash: null })) }))) as { success: boolean; code?: string };
  };
  expect(await call(make('b'), 'alias/missing.css')).toMatchObject({ success: false, code: 'PERMISSION_DENIED' });
  expect(await call(make(), 'alias/missing.css')).toMatchObject({ success: false, code: 'WRITER_ACTIVE' });
  await expect(readFile(join(root, 'missing.css'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await call(make('b'), 'ordinary.txt')).toMatchObject({ success: true });
  expect(await readFile(join(caller, 'ordinary.txt'), 'utf8')).toBe('new');
  await t.store.finishTurn('active', 'completed');
});

it('allows ordinary unmanaged turns in parallel while still blocking racing registration', async () => {
  const store = make();
  await store.beginTurn({ directory: root, sessionId: 'one', runId: 'one', prompt: 'read' });
  await store.beginTurn({ directory: root, sessionId: 'two', runId: 'two', prompt: 'read' });
  expect(await store.catalog()).toEqual([]);
  await expect(store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'racing' })).rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
  await store.finishTurn('one', 'completed'); await store.finishTurn('two', 'completed');
  await expect(store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'after' })).resolves.toMatchObject({ kind: 'markdown' });
});

it('keeps long ordinary prompts usable without weakening the managed metadata limit', async () => {
  const store = make(), prompt = 'x'.repeat(65537);
  await runArtifactTurn(store, { directory: root, sessionId: 'ordinary', prompt }, async () => { await writeFile(join(root, 'a.md'), 'ordinary turn ran'); return { aborted: false }; });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('ordinary turn ran');
  await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'managed' });
  await expect(runArtifactTurn(store, { directory: root, sessionId: 'managed', prompt }, async () => { throw new Error('Must not execute'); })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
});

it.each([false, true])('permits rollback after an unsuccessful capture retry, including old pinned resume=%s', async oldPinned => {
  const t = await failedCapture(), op = await t.store.operation(t.artifact.workspaceId, 'capture-run');
  await expect(t.store.resolveOperation({ workspaceId: t.artifact.workspaceId, operationId: 'capture-run', resolutionId: 'retry', action: 'resume', expectedObservedRevision: op.observedRevision })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  if (oldPinned) { const path = join(storage, 'catalog.json'), db = JSON.parse(await readFile(path, 'utf8')); db.workspaces[0].captureFailure.resolution = { id: 'retry', action: 'resume' }; await writeFile(path, JSON.stringify(db)); }
  const restarted = make(); await restarted.recover();
  await restarted.resolveOperation({ workspaceId: t.artifact.workspaceId, operationId: 'capture-run', resolutionId: 'rollback', action: 'rollback', expectedObservedRevision: (await restarted.operation(t.artifact.workspaceId, 'capture-run')).observedRevision });
  expect((await restarted.read(t.ref)).workingState).toBe('clean');
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('baseline');
});

it('keeps a timed-out terminal queryable and recovers it after restart without mutating selected history', async () => {
  const t = await registered(); await t.store.beginTurn({ directory: root, sessionId: 's', runId: 'timeout', prompt: 'edit' }); await writeFile(join(root, 'a.md'), 'finished bytes');
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = withMachineLock(storage, async () => { started(); await new Promise<void>(resolve => { release = resolve; }); }); await ready;
  try { await expect(t.store.finishTurn('timeout', 'completed')).rejects.toMatchObject({ code: 'COMMIT_PENDING', operationId: 'timeout' }); }
  finally { release(); await held; }
  expect((await t.store.read({ ...t.ref, versionId: t.artifact.currentVersionId })).entryContent).toBe('baseline');
  expect((await t.store.versions(t.ref)).versions).toHaveLength(1);
  expect(JSON.parse(await readFile(join(storage, 'a'.repeat(64), 'terminals', 'timeout.json'), 'utf8'))).toMatchObject({ runId: 'timeout', status: 'completed', owner: { pid: process.pid } });
  const restarted = make(); await restarted.recover();
  expect(await restarted.operation(t.artifact.workspaceId, 'timeout')).toMatchObject({ status: 'committed' });
  expect(await restarted.read(t.ref)).toMatchObject({ workingState: 'clean', entryContent: 'finished bytes' });
  expect((await restarted.versions(t.ref)).versions).toHaveLength(2);
}, 20000);
