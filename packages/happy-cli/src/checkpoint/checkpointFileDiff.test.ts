import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCheckpointRpcHandlers } from './checkpointRpc';
import { CheckpointStore } from './checkpointStore';

let root: string;
let projectPath: string;
let checkpointRoot: string;
const binding = { sessionId: 'diff-session', projectId: 'diff-project', worktreeId: null };
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'checkpoint-diff-'));
    projectPath = join(root, 'project'); checkpointRoot = join(root, 'history');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'a.txt'), 'recorded\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
    const { checkpointId } = await new CheckpointStore(checkpointRoot).snapshotTurn({
        ...binding, projectPath, operationId: 'before', excludedPatterns: ['.env*'],
        workTree: { maxFileBytes: 10 * 1024 * 1024, record: 'before' },
    });
    const handlers = createCheckpointRpcHandlers({ checkpointRoot,
        resolveAuthority: async () => ({ ...binding, projectPath, mode: 'local-history',
            protection: { status: 'protected' }, pendingDecision: null, excludedPaths: [], excludedPatterns: ['.env*'] }),
        resolveEventPublisher: async () => null, restartSession: async () => {},
    });
    return { handlers, request: { schemaVersion: 1, ...binding, checkpointId, path: 'a.txt' } };
}
it('compares current to recorded bytes without changing current files or emitting an event', async () => {
    const { handlers, request } = await fixture();
    expect(await handlers.diff!(request)).toMatchObject({ status: 'text', diff: '' });
    await writeFile(join(projectPath, 'a.txt'), 'current\n');
    const result = await handlers.diff!(request) as { status: string; diff: string };
    expect(result.status).toBe('text');
    expect(result.diff).toContain('-current\n+recorded');
    expect(await readFile(join(projectPath, 'a.txt'), 'utf8')).toBe('current\n');
});
it('handles deleted and newly created files, including empty files', async () => {
    const { handlers, request } = await fixture();
    await rm(join(projectPath, 'a.txt'));
    expect(await handlers.diff!(request)).toMatchObject({ status: 'text', diff: expect.stringContaining('+recorded') });
    await writeFile(join(projectPath, 'new.txt'), 'new\n');
    expect(await handlers.diff!({ ...request, path: 'new.txt' })).toMatchObject({ status: 'text', diff: expect.stringContaining('-new') });
    await writeFile(join(projectPath, 'empty.txt'), '');
    expect(await handlers.diff!({ ...request, path: 'empty.txt' })).toMatchObject({ status: 'text', diff: expect.stringContaining('deleted file mode') });
});
it('rejects other bindings, unowned checkpoints, excluded paths and traversal', async () => {
    const { handlers, request } = await fixture();
    await writeFile(join(projectPath, '.env.local'), 'secret');
    await expect(handlers.diff!({ ...request, projectId: 'other' })).rejects.toThrow('binding');
    await expect(handlers.diff!({ ...request, checkpointId: 'f'.repeat(40) })).rejects.toThrow();
    for (const path of ['.env.local', '../outside', '/etc/passwd', './a.txt']) {
        await expect(handlers.diff!({ ...request, path })).rejects.toThrow();
    }
});
it('does not follow symlinks or symlink parents', async () => {
    const { handlers, request } = await fixture();
    await writeFile(join(root, 'outside.txt'), 'outside secret');
    await rm(join(projectPath, 'a.txt'));
    await symlink(join(root, 'outside.txt'), join(projectPath, 'a.txt'));
    await expect(handlers.diff!(request)).rejects.toThrow();
    await symlink(root, join(projectPath, 'outside'));
    await expect(handlers.diff!({ ...request, path: 'outside/outside.txt' })).rejects.toThrow();
});
it('returns explicit binary and size statuses with no file content', async () => {
    const { handlers, request } = await fixture();
    await writeFile(join(projectPath, 'a.txt'), Buffer.from([0, 1, 2]));
    expect(await handlers.diff!(request)).toMatchObject({ status: 'binary', diff: '' });
    await writeFile(join(projectPath, 'a.txt'), 'x'.repeat(1024 * 1024 + 1));
    expect(await handlers.diff!(request)).toMatchObject({ status: 'too-large', diff: '' });
});

it('shows creation of an empty recorded file even though its bytes match an absent file', async () => {
    await writeFile(join(projectPath, 'empty.txt'), '');
    const { handlers, request } = await fixture();
    await rm(join(projectPath, 'empty.txt'));
    expect(await handlers.diff!({ ...request, path: 'empty.txt' })).toMatchObject({
        status: 'text', diff: expect.stringContaining('new file mode 100644'),
    });
});
