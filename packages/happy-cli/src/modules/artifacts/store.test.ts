import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from './store';

let directory: string;
let root: string;
let storage: string;
const inventory = async () => [];
const make = () => new ArtifactStore({ storage, accountScope: 'a'.repeat(64), inventory });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'paws-versions-')); root = join(directory, 'project'); storage = join(directory, 'private'); await mkdir(root); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('durable artifact versions', () => {
  it.each(['md', 'html'])('retains exact %s bytes across edits, restoration and a fresh store', async ext => {
    await writeFile(join(root, `entry.${ext}`), '一版\n');
    const store = make();
    const artifact = await store.register({ root, entryPath: `entry.${ext}`, managedPaths: [`entry.${ext}`], operationId: 'register' });
    const ref = { workspaceId: artifact.workspaceId, artifactId: artifact.id };
    const first = await store.read(ref);
    const v2 = await store.save({ ...ref, operationId: 'edit-2', expectedRevision: first.workingRevision, entryContent: '二版\n', prompt: '改成二版' });
    const v3 = await store.save({ ...ref, operationId: 'edit-3', expectedRevision: v2.workingRevision, entryContent: '三版\n' });
    expect((await store.versions(ref)).versions.map(v => v.source)).toEqual(['manual', 'manual', 'baseline']);
    expect((await store.read({ ...ref, versionId: artifact.currentVersionId })).entryContent).toBe('一版\n');
    const restored = await store.restore({ ...ref, operationId: 'restore', expectedRevision: v3.workingRevision, versionId: artifact.currentVersionId });
    expect(restored.version.restoreFromVersionId).toBe(artifact.currentVersionId);
    expect(restored.version.source).toBe('restore');
    expect((await make().versions(ref)).versions).toHaveLength(4);
    expect((await make().read(ref)).entryContent).toBe('一版\n');
    expect(await readFile(join(root, `entry.${ext}`), 'utf8')).toBe('一版\n');
    expect((await make().save({ ...ref, operationId: 'edit-2', expectedRevision: first.workingRevision, entryContent: '二版\n', prompt: '改成二版' })).version.id).toBe(v2.version.id);
    await expect(make().save({ ...ref, operationId: 'stale', expectedRevision: v2.workingRevision, entryContent: 'overwrite' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('freezes relative resources for both version and dirty reads without adding history', async () => {
    await writeFile(join(root, 'entry.html'), '<link href="style.css">'); await writeFile(join(root, 'style.css'), 'old');
    const store = make(); const artifact = await store.register({ root, entryPath: 'entry.html', managedPaths: ['entry.html', 'style.css'], operationId: 'register' });
    const ref = { workspaceId: artifact.workspaceId, artifactId: artifact.id };
    await writeFile(join(root, 'style.css'), 'dirty');
    const frozen = await store.read(ref);
    expect(frozen.readRef.kind).toBe('working');
    await writeFile(join(root, 'style.css'), 'newer');
    expect(Buffer.from((await store.resource({ ...ref, readRef: frozen.readRef, path: 'style.css', offset: 0, length: 256 })).content, 'base64').toString()).toBe('dirty');
    expect((await store.versions(ref)).versions).toHaveLength(1);
    const now = await store.read(ref);
    await store.restore({ ...ref, operationId: 'restore', expectedRevision: now.workingRevision, versionId: artifact.currentVersionId });
    expect(await readFile(join(root, 'style.css'), 'utf8')).toBe('old');
    expect((await store.versions(ref)).versions.map(v => v.source)).toEqual(['restore', 'external', 'baseline']);
  });
});

it('preserves AI baselines, deduplicates terminal events and blocks restore throughout a real process lease', async () => {
  await writeFile(join(root, 'a.md'), 'baseline');
  const store = make(), artifact = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' });
  const ref = { workspaceId: artifact.workspaceId, artifactId: artifact.id };
  await store.beginTurn({ directory: root, sessionId: 'session-a', runId: 'turn-a', prompt: '修改文档' });
  await writeFile(join(root, 'a.md'), 'AI result');
  expect((await store.read(ref)).workingState).toBe('writing');
  expect((await store.read(ref)).entryContent).toBe('baseline');
  await expect(make().restore({ ...ref, operationId: 'busy', expectedRevision: (await store.read(ref)).workingRevision, versionId: artifact.currentVersionId })).rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
  await expect(make().beginTurn({ directory: root, sessionId: 'session-b', runId: 'turn-b', prompt: 'race' })).rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
  await store.finishTurn('turn-a', 'completed');
  await make().finishTurn('turn-a', 'completed');
  expect((await store.versions(ref)).versions).toMatchObject([{ source: 'ai', prompt: '修改文档', runId: 'turn-a' }, { source: 'baseline' }]);
  await store.beginTurn({ directory: root, sessionId: 'session-a', runId: 'unchanged', prompt: 'read' });
  await store.finishTurn('unchanged', 'completed');
  expect((await store.versions(ref)).versions).toHaveLength(2);
  await store.beginTurn({ directory: root, sessionId: 'session-a', runId: 'failed', prompt: 'partial' });
  await writeFile(join(root, 'a.md'), 'partial result');
  await store.finishTurn('failed', 'failed');
  expect((await store.read(ref)).workingState).toBe('dirty');
  expect((await store.versions(ref)).versions).toHaveLength(2);
});

it('blocks registration during an already running upgraded turn and legacy or unknown worker inventories', async () => {
  await writeFile(join(root, 'a.md'), 'baseline');
  await make().beginTurn({ directory: root, sessionId: 'session-a', runId: 'before-registration', prompt: 'writing' });
  await expect(make().register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' })).rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
  await make().finishTurn('before-registration', 'completed');
  const legacy = new ArtifactStore({ storage, accountScope: 'a'.repeat(64), inventory: async () => [{ pid: process.pid, directory: root }] });
  await expect(legacy.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
});


it('rejects stale file references before handing files to a runner', async () => {
  await writeFile(join(root, 'a.md'), 'current');
  const store = make();
  await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' });
  await expect(store.beginTurn({ directory: root, sessionId: 'session', runId: 'stale-reference', prompt: 'edit', reference: { path: 'a.md', hash: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('current');
});

it('makes terminal capture failure recoverable instead of holding an ended writer forever', async () => {
  await writeFile(join(root, 'a.md'), 'baseline');
  const store = make(), a = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' });
  const ref = { workspaceId: a.workspaceId, artifactId: a.id };
  await store.beginTurn({ directory: root, sessionId: 's', runId: 'deleted-entry', prompt: 'edit' });
  const { unlink } = await import('node:fs/promises'); await unlink(join(root, 'a.md'));
  await expect(store.finishTurn('deleted-entry', 'completed')).rejects.toMatchObject({ code: 'COMMIT_PENDING', operationId: 'capture-deleted-entry' });
  expect(await store.read(ref)).toMatchObject({ workingState: 'recovery-required', entryContent: 'baseline' });
  const op = await store.operation(a.workspaceId, 'capture-deleted-entry'); expect(op.actions).toContain('rollback');
  await store.resolveOperation({ workspaceId: a.workspaceId, operationId: 'capture-deleted-entry', resolutionId: 'recover-entry', action: 'rollback', expectedObservedRevision: op.observedRevision });
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('baseline');
  await store.beginTurn({ directory: root, sessionId: 's', runId: 'next', prompt: 'read' }); await store.finishTurn('next', 'completed');
});

it('round-trips a UTF-8 BOM and CRLF without silently changing exact historical bytes', async () => {
  const content = '\uFEFF# one\r\n'; await writeFile(join(root, 'a.md'), content);
  const store = make(), a = await store.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'bom' });
  expect((await store.read({ workspaceId: a.workspaceId, artifactId: a.id, versionId: a.currentVersionId })).entryContent).toBe(content);
});
