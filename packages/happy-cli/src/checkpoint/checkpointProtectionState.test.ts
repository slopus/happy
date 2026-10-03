import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { resolveCheckpointStoreLayout } from './checkpointStore';
import { CheckpointRefreshRejectedError, checkpointRecoveryRevision } from './checkpointRecovery';

describe('CheckpointProtectionStateStore', () => {
    let root: string;
    let projectPath: string;
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    } as const;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happy-checkpoint-protection-'));
        projectPath = join(root, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('durably records only relative excluded paths and retry warnings', async () => {
        const store = new CheckpointProtectionStateStore(join(root, 'checkpoints'));

        await store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [{ path: '.env.production', reason: 'secret' }],
        });

        await expect(new CheckpointProtectionStateStore(join(root, 'checkpoints')).read({
            ...binding,
            projectPath,
        })).resolves.toEqual({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: 'turn-1',
                source: 'policy-drift',
                excluded: [{ path: '.env.production', reason: 'secret' }],
                warnings: {
                    partialExecutionPossible: true,
                    externalSideEffectsMayRepeat: true,
                },
            },
        });
    });

    it('keeps protection enabled on cancel and rejects a stale operation decision', async () => {
        const store = new CheckpointProtectionStateStore(join(root, 'checkpoints'));
        await store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-current',
            source: 'turn-apply',
            excluded: [{ path: 'large.bin', reason: 'too-large' }],
        });

        await expect(store.resolveDecision({
            ...binding,
            projectPath,
            operationId: 'turn-stale',
            decision: 'cancel',
        })).rejects.toThrow('pending operation mismatch');
        await expect(store.resolveDecision({
            ...binding,
            projectPath,
            operationId: 'turn-current',
            decision: 'cancel',
        })).resolves.toEqual({ protection: { status: 'protected' }, pendingDecision: null });
    });

    async function prepareRefresh() {
        const store = new CheckpointProtectionStateStore(join(root, 'checkpoints'));
        const bound = { ...binding, projectPath };
        const status = await store.reportPending({ ...bound, operationId: 'refresh-turn', source: 'policy-drift', excluded: [] });
        return { store, bound, request: { ...bound, operationId: 'refresh-turn', requestId: 'refresh-request',
            revision: checkpointRecoveryRevision(status.pendingDecision!) } };
    }

    it('retries a definite pre-resume rejection but not an unknown resume outcome', async () => {
        const { store, request } = await prepareRefresh();
        const restart = vi.fn().mockRejectedValueOnce(new CheckpointRefreshRejectedError('not started')).mockResolvedValue(undefined);
        await expect(store.refreshPending(request, restart)).rejects.toThrow('not started');
        await expect(store.refreshPending(request, restart)).resolves.toBe('refreshed');
        await expect(store.refreshPending(request, restart)).resolves.toBe('refreshed');
        expect(restart).toHaveBeenCalledTimes(2);
    });

    it('does not repeat an uncertain restart even with a new request id', async () => {
        const { store, request } = await prepareRefresh();
        const restart = vi.fn().mockRejectedValue(new Error('unknown fixture outcome'));
        await expect(store.refreshPending(request, restart)).rejects.toThrow('unknown fixture outcome');
        await expect(store.refreshPending({ ...request, requestId: 'new-request' }, restart)).resolves.toBe('outcome-unknown');
        expect(restart).toHaveBeenCalledOnce();
    });

    it('allows a new operation to recover after an uncertain restart settles and is cancelled', async () => {
        const { store, bound, request } = await prepareRefresh();
        await expect(store.refreshPending(request, async () => { throw new Error('unknown'); })).rejects.toThrow('unknown');
        await store.resolveDecision({ ...bound, operationId: request.operationId, decision: 'cancel' });
        const next = await store.reportPending({ ...bound, operationId: 'new-operation', source: 'policy-drift', excluded: [] });
        const restart = vi.fn(async () => {});
        await expect(store.refreshPending({ ...bound, operationId: 'new-operation', requestId: 'new-request',
            revision: checkpointRecoveryRevision(next.pendingDecision!) }, restart)).resolves.toBe('refreshed');
        expect(restart).toHaveBeenCalledOnce();
    });

    it('does not abandon an in-flight restart when a newer operation becomes pending', async () => {
        const { store, bound, request } = await prepareRefresh();
        let started!: () => void;
        const didStart = new Promise<void>(resolve => { started = resolve; });
        let finish!: () => void;
        const release = new Promise<void>(resolve => { finish = resolve; });
        const first = store.refreshPending(request, async () => { started(); await release; });
        await didStart;
        await store.resolveDecision({ ...bound, operationId: request.operationId, decision: 'cancel' });
        const next = await store.reportPending({ ...bound, operationId: 'new-operation', source: 'policy-drift', excluded: [] });
        const restart = vi.fn(async () => {});
        const nextRequest = { ...bound, operationId: 'new-operation', requestId: 'new-request',
            revision: checkpointRecoveryRevision(next.pendingDecision!) };
        await expect(store.refreshPending(nextRequest, restart)).resolves.toBe('outcome-unknown');
        expect(restart).not.toHaveBeenCalled();
        finish();
        await first;
        await expect(store.refreshPending(nextRequest, restart)).resolves.toBe('refreshed');
    });

    it('abandons an older prepared operation only when its owner is proven stopped', async () => {
        const { store, bound, request } = await prepareRefresh();
        await expect(store.refreshPending(request, async () => { throw new Error('unknown'); })).rejects.toThrow('unknown');
        await store.resolveDecision({ ...bound, operationId: request.operationId, decision: 'cancel' });
        const next = await store.reportPending({ ...bound, operationId: 'new-operation', source: 'policy-drift', excluded: [] });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot: join(root, 'checkpoints'), ...binding });
        const journalFile = join(layout.gitDirectory, 'protection', `${basename(layout.metadataFile)}.refresh`);
        const journal = JSON.parse(await readFile(journalFile, 'utf8'));
        await writeFile(journalFile, JSON.stringify({ ...journal, ownerPid: 999_999, restartSettled: false }));
        const restart = vi.fn(async () => {});
        const nextRequest = { ...bound, operationId: 'new-operation', requestId: 'new-request',
            revision: checkpointRecoveryRevision(next.pendingDecision!) };
        const processProbe = vi.spyOn(process, 'kill').mockImplementation(() => true);
        await expect(store.refreshPending(nextRequest, restart)).resolves.toBe('outcome-unknown');
        expect(restart).not.toHaveBeenCalled();
        processProbe.mockImplementation(() => { throw Object.assign(new Error('stopped'), { code: 'ESRCH' }); });
        await expect(store.refreshPending(nextRequest, restart)).resolves.toBe('refreshed');
        processProbe.mockRestore();
    });

    it('allows a safe cancel during restart without clearing a newer pending decision', async () => {
        const { store, bound, request } = await prepareRefresh();
        let started!: () => void;
        const didStart = new Promise<void>(resolve => { started = resolve; });
        let finish!: () => void;
        const release = new Promise<void>(resolve => { finish = resolve; });
        const refresh = store.refreshPending(request, async () => { started(); await release; });
        await didStart;
        await store.resolveDecision({ ...bound, operationId: request.operationId, decision: 'cancel' });
        await store.reportPending({ ...bound, operationId: 'new-turn', source: 'turn-apply', excluded: [] });
        finish();
        await refresh;
        expect((await store.read(bound)).pendingDecision?.operationId).toBe('new-turn');
    });

    it('reclaims an aged legacy token lock without stealing a live modern lock', async () => {
        const { store, bound, request } = await prepareRefresh();
        const layout = resolveCheckpointStoreLayout({ checkpointRoot: join(root, 'checkpoints'), ...binding });
        const lockFile = join(layout.gitDirectory, 'protection', `${basename(layout.metadataFile)}.lock`);
        await writeFile(lockFile, 'legacy-token');
        const old = new Date(Date.now() - 31_000);
        await utimes(lockFile, old, old);
        await expect(store.resolveDecision({ ...bound, operationId: request.operationId, decision: 'cancel' }))
            .resolves.toMatchObject({ protection: { status: 'protected' }, pendingDecision: null });
    });

    it('persists explicit protection disable across store instances', async () => {
        const checkpointRoot = join(root, 'checkpoints');
        const store = new CheckpointProtectionStateStore(checkpointRoot);
        await store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [],
        });

        await expect(store.resolveDecision({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            decision: 'disable-protection',
        })).resolves.toEqual({
            protection: { status: 'unavailable', reason: 'excluded-path' },
            pendingDecision: null,
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            ...binding,
            projectPath,
        })).resolves.toEqual({
            protection: { status: 'unavailable', reason: 'excluded-path' },
            pendingDecision: null,
        });
    });

    it.each([
        '/absolute',
        '../outside',
        'C:outside.txt',
        'safe\0secret',
    ])('rejects an unsafe pending path: %j', async (path) => {
        const store = new CheckpointProtectionStateStore(join(root, 'checkpoints'));
        await expect(store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [{ path, reason: 'secret' }],
        })).rejects.toThrow('project-relative');
    });
});
