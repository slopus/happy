import { withMachineLock } from './files';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from './store';
const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'paws-artifact-process-')); dirs.push(dir); const root = join(dir, 'project'), storage = join(dir, 'store'); await mkdir(root); await writeFile(join(root, 'a.md'), 'baseline'); const store = new ArtifactStore({ storage, accountScope: 'a'.repeat(64), inventory: async () => [] }); const a = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' }); const ref = { workspaceId: a.workspaceId, artifactId: a.id }; return { root, storage, store, a, ref }; }
function child(options: unknown) { const process = spawn(globalThis.process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'process.fixture.ts'), JSON.stringify(options)], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(process); return process; }
async function output(process: ChildProcess) { let result = ''; process.stdout!.on('data', chunk => result += chunk); let errors = ''; process.stderr!.on('data', chunk => errors += chunk); const [code] = await once(process, 'exit'); expect(code, errors).toBe(0); return JSON.parse(result); }
it('excludes another real worker process for the full turn, then recovers its dead lease without TTL expiry', async () => {
  const t = await setup(), worker = child({ ...t, store: undefined, action: 'lease' });
  expect(String((await once(worker.stdout!, 'data'))[0])).toContain('LEASED');
  await expect(t.store.restore({ ...t.ref, operationId: 'busy', expectedRevision: (await t.store.read(t.ref)).workingRevision, versionId: t.a.currentVersionId })).rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
  worker.kill('SIGKILL'); await once(worker, 'exit');
  await writeFile(join(t.root, 'a.md'), 'partial child bytes');
  const read = await t.store.read(t.ref); expect(read.workingState).toBe('dirty');
  await t.store.restore({ ...t.ref, operationId: 'after-crash', expectedRevision: read.workingRevision, versionId: t.a.currentVersionId });
  expect((await t.store.versions(t.ref)).versions.map(v => v.source)).toEqual(['restore', 'external', 'baseline']);
});
it('allows only one of two actual processes to save the same expected revision', async () => {
  const t = await setup(), expectedRevision = (await t.store.read(t.ref)).workingRevision;
  const results = await Promise.all(['one', 'two'].map(text => output(child({ storage: t.storage, root: t.root, action: 'save', request: { ...t.ref, operationId: text, expectedRevision, entryContent: text } }))));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(['CONFLICT', 'WRITER_ACTIVE']).toContain(results.find(r => !r.ok).code);
  expect((await t.store.versions(t.ref)).versions).toHaveLength(2);
  expect(['one', 'two']).toContain(await readFile(join(t.root, 'a.md'), 'utf8'));
});

it('serializes a restore against a competing process save using the actual current set revision', async () => {
  const t = await setup();
  const second = await t.store.save({ ...t.ref, operationId: 'second', expectedRevision: (await t.store.read(t.ref)).workingRevision, entryContent: 'second' });
  const results = await Promise.all([
    output(child({ storage: t.storage, action: 'restore', request: { ...t.ref, operationId: 'restore-race', expectedRevision: second.workingRevision, versionId: t.a.currentVersionId } })),
    output(child({ storage: t.storage, action: 'save', request: { ...t.ref, operationId: 'save-race', expectedRevision: second.workingRevision, entryContent: 'third' } })),
  ]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(['CONFLICT', 'WRITER_ACTIVE']).toContain(results.find(r => !r.ok).code);
  expect((await t.store.versions(t.ref)).versions).toHaveLength(3);
});


it('keeps a live native child excluded after its supervising worker exits', async () => {
  const t = await setup();
  const native = spawn(globalThis.process.execPath, ['-e', "require('net').createServer(()=>{}).listen(0,'127.0.0.1',()=>process.stdout.write('READY\\n'))"], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(native); await once(native.stdout!, 'data');
  const worker = child({ storage: t.storage, root: t.root, action: 'lease', trackPid: native.pid });
  await once(worker.stdout!, 'data'); worker.kill('SIGKILL'); await once(worker, 'exit');
  expect((await t.store.read(t.ref)).workingState).toBe('writing');
  await expect(t.store.restore({ ...t.ref, operationId: 'orphaned-native', expectedRevision: (await t.store.read(t.ref)).workingRevision, versionId: t.a.currentVersionId })).rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
  native.kill('SIGKILL'); await once(native, 'exit');
  await t.store.restore({ ...t.ref, operationId: 'native-ended', expectedRevision: (await t.store.read(t.ref)).workingRevision, versionId: t.a.currentVersionId });
});


it('recovers a durable terminal after its real worker times out on the lock and exits', async () => {
  const t = await setup(), worker = child({ storage: t.storage, root: t.root, action: 'lease', allowPending: true });
  expect(String((await once(worker.stdout!, 'data'))[0])).toContain('LEASED');
  await writeFile(join(t.root, 'a.md'), 'worker completed');
  const exited = once(worker, 'exit');
  await withMachineLock(t.storage, async () => {
    worker.stdin!.write('finish');
    expect((await exited)[0]).toBe(0);
  });
  expect((await t.store.versions(t.ref)).versions).toHaveLength(1);
  await t.store.recover();
  expect(await t.store.operation(t.a.workspaceId, 'child-run')).toMatchObject({ status: 'committed' });
  expect((await t.store.versions(t.ref)).versions.map(v => v.source)).toEqual(['ai', 'baseline']);
  expect(await t.store.read(t.ref)).toMatchObject({ entryContent: 'worker completed', workingState: 'clean' });
}, 20000);
