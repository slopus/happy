import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointLedger } from './checkpointLedger';
import { createCheckpointRpcHandlers } from './checkpointRpc';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { CheckpointRestoreExecutor, type CheckpointRestoreMutation } from './checkpointRestore';
import { CheckpointStore } from './checkpointStore';
import { createCheckpointLocalHistory } from './checkpointLocalHistory';

const operationId = (sequence: number): string => (
    `123e4567-e89b-42d3-a456-${sequence.toString().padStart(12, '0')}`
);

describe('checkpoint daemon RPC', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;
    const authority = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    } as const;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-rpc-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'tracked.txt'), 'user version\n');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    function createHandlers(
        restoreExecutor?: CheckpointRestoreExecutor,
        rewind = vi.fn(async () => ({
            id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false,
        })),
        restartSession = vi.fn(async () => {}),
        refreshSession?: () => Promise<void>,
        exclusions: { excludedPaths: string[]; excludedPatterns: string[] } = { excludedPaths: [], excludedPatterns: [] },
    ) {
        const protectionState = new CheckpointProtectionStateStore(checkpointRoot);
        return createCheckpointRpcHandlers({
            checkpointRoot,
            ...(restoreExecutor ? { restoreExecutor } : {}),
            resolveEventPublisher: async () => ({ rewind }),
            restartSession,
            ...(refreshSession ? { refreshSession } : {}),
            resolveAuthority: async (sessionId) => {
                if (sessionId !== authority.sessionId) return null;
                const state = await protectionState.read({ ...authority, projectPath });
                return {
                    ...authority,
                    projectPath,
                    ...state,
                    ...exclusions,
                };
            },
        });
    }

    it('advertises phase-aware recovery and refreshes a pending preparation only once', async () => {
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        await state.reportPending({ ...authority, projectPath, operationId: operationId(11),
            source: 'policy-drift', excluded: [{ path: 'large.bin', reason: 'too-large' }] });
        const restart = vi.fn(async () => {
            expect((await state.read({ ...authority, projectPath })).pendingDecision).not.toBeNull();
        });
        const handlers = createHandlers(undefined, undefined, undefined, restart);
        const status = await handlers.status({ schemaVersion: 1, ...authority }) as {
            recovery: { diagnostic: { phase: string; revision: string } };
        };
        expect(status.recovery.diagnostic.phase).toBe('before-dispatch');
        const request = { schemaVersion: 1, ...authority, operationId: operationId(11),
            requestId: operationId(12), revision: status.recovery.diagnostic.revision, timeout: 70_000 };
        await expect(handlers.refresh!({ ...request, revision: '0'.repeat(64) })).rejects.toThrow('revision mismatch');
        await expect(handlers.refresh!({ ...request, projectId: 'other-project' })).rejects.toThrow('binding mismatch');
        await expect(handlers.refresh!(request)).resolves.toMatchObject({ status: 'refreshed' });
        await expect(handlers.refresh!(request)).resolves.toMatchObject({ status: 'refreshed' });
        expect(restart).toHaveBeenCalledOnce();
        expect((await state.read({ ...authority, projectPath })).pendingDecision).toBeNull();
    });

    it('does not replay an uncertain protected refresh or refresh an already dispatched write', async () => {
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        await state.reportPending({ ...authority, projectPath, operationId: operationId(13), source: 'policy-drift', excluded: [] });
        const restart = vi.fn(async () => { throw new Error('replacement outcome unknown'); });
        const handlers = createHandlers(undefined, undefined, undefined, restart);
        const status = await handlers.status({ schemaVersion: 1, ...authority }) as {
            recovery: { diagnostic: { revision: string } };
        };
        const request = { schemaVersion: 1, ...authority, operationId: operationId(13),
            requestId: operationId(14), revision: status.recovery.diagnostic.revision, timeout: 70_000 };
        await expect(handlers.refresh!(request)).rejects.toThrow('outcome unknown');
        await expect(handlers.refresh!(request)).resolves.toMatchObject({ status: 'outcome-unknown' });
        expect(restart).toHaveBeenCalledOnce();
        expect((await state.read({ ...authority, projectPath })).protection.status).toBe('protected');
        await state.reportPending({ ...authority, projectPath, operationId: operationId(15),
            source: 'turn-apply', excluded: [{ path: '.env', reason: 'secret' }] });
        const next = await handlers.status({ schemaVersion: 1, ...authority }) as typeof status;
        await expect(handlers.refresh!({ ...request, operationId: operationId(15), requestId: operationId(16),
            revision: next.recovery.diagnostic.revision })).rejects.toThrow('explicit cancellation');
        expect(restart).toHaveBeenCalledOnce();
    });

    function createUnavailableHandlers() {
        return createCheckpointRpcHandlers({
            checkpointRoot,
            resolveEventPublisher: async () => null,
            restartSession: async () => {},
            resolveAuthority: async () => ({
                ...authority,
                projectPath,
                protection: { status: 'unavailable' as const, reason: 'excluded-path' as const },
                pendingDecision: null,
                excludedPaths: [],
                excludedPatterns: [],
            }),
        });
    }

    async function createAgentModifiedCheckpoint(): Promise<string> {
        await writeFile(join(projectPath, 'tracked.txt'), 'before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...authority,
            operationId: operationId(1),
            projectPath,
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version\n');
        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...authority,
            operationId: operationId(1),
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        });
        return snapshot.checkpointId;
    }

    async function createTwoFileCheckpoint(): Promise<string> {
        await writeFile(join(projectPath, 'a.txt'), 'a before\n');
        const snapshot = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...authority,
            operationId: operationId(2),
            projectPath,
        });
        const ledger = new CheckpointLedger(checkpointRoot);
        await writeFile(join(projectPath, 'a.txt'), 'a agent\n');
        await ledger.recordMutation({
            ...authority,
            operationId: operationId(2),
            mutationId: 'mutation-a',
            projectPath,
            path: 'a.txt',
            action: 'written',
        });
        await writeFile(join(projectPath, 'b.txt'), 'b agent-created\n');
        await ledger.recordMutation({
            ...authority,
            operationId: operationId(2),
            mutationId: 'mutation-b',
            projectPath,
            path: 'b.txt',
            action: 'written',
        });
        return snapshot.checkpointId;
    }

    it('previews current exclusions instead of offering a restore that execute rejects', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        const handlers = createHandlers(undefined, undefined, undefined, undefined, {
            excludedPaths: ['tracked.txt'], excludedPatterns: [],
        });
        const preview = await handlers.preview({ schemaVersion: 1, ...authority, checkpointId });
        expect(preview).toMatchObject({ entries: [{ path: 'tracked.txt', action: 'skip' }] });
        expect(await handlers.execute({ schemaVersion: 1, ...authority, operationId: operationId(18),
            confirmed: true, plan: { schemaVersion: 1, checkpointId, entries: (preview as { entries: unknown[] }).entries } }))
            .toMatchObject({ status: 'completed' });
    });

    it('rejects a preview whose requested project binding differs from daemon authority', async () => {
        const handlers = createHandlers();

        await expect(handlers.preview({
            schemaVersion: 1,
            ...authority,
            projectId: 'other-project',
            checkpointId: 'a'.repeat(40),
        })).rejects.toThrow('checkpoint RPC binding mismatch');

        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8'))
            .resolves.toBe('user version\n');
        await expect(access(checkpointRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects a non-UUID restore operation before resolving authority or mutating files', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        const handlers = createHandlers();
        const plan = await handlers.preview({
            schemaVersion: 1,
            ...authority,
            checkpointId,
        });

        await expect(handlers.execute({
            schemaVersion: 1,
            ...authority,
            operationId: 'restore-not-a-uuid',
            confirmed: true,
            plan,
        })).rejects.toThrow();
        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8')).resolves.toBe('agent version\n');
    });

    it('reports protection status from daemon session authority', async () => {
        const handlers = createHandlers();

        await expect(handlers.status({
            schemaVersion: 1,
            ...authority,
        })).resolves.toEqual({
            schemaVersion: 1,
            ...authority,
            protection: { status: 'protected' },
            pendingDecision: null,
        });
    });

    it('exact-binds cancellation of a pending excluded-path decision', async () => {
        const store = new CheckpointProtectionStateStore(checkpointRoot);
        await store.reportPending({
            ...authority,
            projectPath,
            operationId: operationId(3),
            source: 'policy-drift',
            excluded: [{ path: '.env', reason: 'secret' }],
        });
        const handlers = createHandlers();

        await expect(handlers.status({ schemaVersion: 1, ...authority })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: operationId(3),
                excluded: [{ path: '.env', reason: 'secret' }],
                warnings: {
                    partialExecutionPossible: true,
                    externalSideEffectsMayRepeat: true,
                },
            },
        });
        await expect(handlers.decision({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(4),
            decision: 'cancel',
        })).rejects.toThrow('pending operation mismatch');
        await expect(handlers.decision({
            schemaVersion: 1,
            ...authority,
            projectId: 'other-project',
            operationId: operationId(3),
            decision: 'cancel',
        })).rejects.toThrow('binding mismatch');
        await expect(handlers.decision({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(3),
            decision: 'cancel',
        })).resolves.toEqual({
            schemaVersion: 1,
            ...authority,
            protection: { status: 'protected' },
            pendingDecision: null,
        });
    });

    it('durably disables protection only after an explicit pending decision', async () => {
        const store = new CheckpointProtectionStateStore(checkpointRoot);
        await store.reportPending({
            ...authority,
            projectPath,
            operationId: operationId(1),
            source: 'turn-apply',
            excluded: [{ path: 'large.bin', reason: 'too-large' }],
        });
        const handlers = createHandlers();

        await expect(handlers.decision({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(1),
            decision: 'disable-protection',
        })).resolves.toEqual({
            schemaVersion: 1,
            ...authority,
            protection: { status: 'unavailable', reason: 'excluded-path' },
            pendingDecision: null,
        });
        await expect(createHandlers().status({
            schemaVersion: 1,
            ...authority,
        })).resolves.toMatchObject({
            protection: { status: 'unavailable', reason: 'excluded-path' },
            pendingDecision: null,
        });
    });

    it('restarts only the exact-bound session after protection was explicitly disabled', async () => {
        const store = new CheckpointProtectionStateStore(checkpointRoot);
        await store.reportPending({
            ...authority,
            projectPath,
            operationId: operationId(5),
            source: 'policy-drift',
            excluded: [{ path: '.env', reason: 'secret' }],
        });
        const restartSession = vi.fn(async () => {});
        const handlers = createHandlers(undefined, undefined, restartSession);
        await expect(handlers.restart({
            schemaVersion: 1,
            ...authority,
            timeout: 70_000,
        })).rejects.toThrow('requires disabled checkpoint protection');
        await handlers.decision({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(5),
            decision: 'disable-protection',
        });

        await expect(handlers.restart({
            schemaVersion: 1,
            ...authority,
            timeout: 70_000,
        })).resolves.toEqual({
            schemaVersion: 1,
            ...authority,
            status: 'restarted',
        });
        expect(restartSession).toHaveBeenCalledWith(expect.objectContaining({
            ...authority,
            projectPath,
            protection: { status: 'unavailable', reason: 'excluded-path' },
        }));
    });

    it('lists only checkpoint ids owned by the authoritative binding', async () => {
        const firstCheckpointId = await createAgentModifiedCheckpoint();
        const second = await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...authority,
            operationId: operationId(6),
            projectPath,
        });
        const handlers = createHandlers();

        const result = await handlers.list({
            schemaVersion: 1,
            ...authority,
        });

        expect(result).toEqual({
            schemaVersion: 1,
            checkpoints: [
                { checkpointId: second.checkpointId, createdAt: expect.any(Number) },
                { checkpointId: firstCheckpointId, createdAt: expect.any(Number) },
            ],
        });
    });

    it('cancels without creating a safety checkpoint or mutating the project', async () => {
        const handlers = createHandlers();

        await expect(handlers.cancel({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(7),
        })).resolves.toEqual({
            schemaVersion: 1,
            operationId: operationId(7),
            status: 'cancelled',
        });

        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8'))
            .resolves.toBe('user version\n');
        await expect(access(checkpointRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    // specs/checkpoint-local-history R4·R5 — skip details travel beside the plan, and a file changed
    // after the last record is restored only when the request includes it.
    it('previews local-history skip details and restores an included file', async () => {
        const recorder = createCheckpointLocalHistory({
            binding: authority, checkpointRoot, projectPath, secretPatterns: ['.env*'],
            checkpointEvents: { snapshot: async () => ({ id: 'event', seq: 1, createdAt: Date.now(), idempotent: false }) },
        });
        const { checkpointId } = await recorder.beforeTurn();
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version\n');
        await recorder.afterTurn();
        await writeFile(join(projectPath, 'tracked.txt'), 'user after record\n');
        const protectionState = new CheckpointProtectionStateStore(checkpointRoot);
        const handlers = createCheckpointRpcHandlers({
            checkpointRoot,
            resolveEventPublisher: async () => ({ rewind: vi.fn(async () => ({ id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false })) }),
            restartSession: vi.fn(async () => {}),
            resolveAuthority: async () => ({
                ...authority, projectPath, ...await protectionState.read({ ...authority, projectPath }),
                mode: 'local-history' as const, excludedPaths: [], excludedPatterns: ['.env*', '.aplus/worktrees/'],
            }),
        });

        const preview = await handlers.preview({ schemaVersion: 1, ...authority, checkpointId });
        expect(preview).toMatchObject({
            entries: [{ path: 'tracked.txt', action: 'skip', reason: 'user-modified' }],
            skipDetails: [{ path: 'tracked.txt', detail: 'changed-after-record' }],
        });
        const included = await handlers.preview({ schemaVersion: 1, ...authority, checkpointId, includePaths: ['tracked.txt'] });
        expect(included).toMatchObject({ entries: [{ path: 'tracked.txt', action: 'restore', reason: 'agent-modified' }] });

        await expect(handlers.execute({
            schemaVersion: 1, ...authority, operationId: operationId(31), confirmed: true,
            includePaths: ['tracked.txt'], plan: included,
        })).resolves.toMatchObject({ status: 'completed' });
        expect(await readFile(join(projectPath, 'tracked.txt'), 'utf8')).toBe('user version\n');
    });

    it('rejects execute without explicit confirmation before filesystem mutation', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        const handlers = createHandlers();
        const preview = await handlers.preview({
            schemaVersion: 1,
            ...authority,
            checkpointId,
        });

        await expect(handlers.execute({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(8),
            confirmed: false,
            plan: preview,
        })).rejects.toBeDefined();

        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8'))
            .resolves.toBe('agent version\n');
    });

    it('rejects confirmed mutation while protection is unavailable', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        const preview = await createHandlers().preview({
            schemaVersion: 1,
            ...authority,
            checkpointId,
        });

        await expect(createUnavailableHandlers().execute({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(9),
            confirmed: true,
            plan: preview,
        })).rejects.toThrow('checkpoint RPC mutation requires protected status');

        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8'))
            .resolves.toBe('agent version\n');
    });

    it('rejects before filesystem mutation when the durable event publisher is unavailable', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        const preview = await createHandlers().preview({
            schemaVersion: 1,
            ...authority,
            checkpointId,
        });
        let mutations = 0;
        const handlers = createCheckpointRpcHandlers({
            checkpointRoot,
            restoreExecutor: new CheckpointRestoreExecutor(checkpointRoot, {
                mutate: async (mutation) => {
                    mutations += 1;
                    await mutation.apply();
                },
            }),
            resolveEventPublisher: async () => null,
            restartSession: async () => {},
            resolveAuthority: async () => ({
                ...authority,
                projectPath,
                protection: { status: 'protected' },
                pendingDecision: null,
                excludedPaths: [],
                excludedPatterns: [],
            }),
        });

        await expect(handlers.execute({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(10),
            confirmed: true,
            plan: preview,
        })).rejects.toThrow('event publisher is unavailable');

        expect(mutations).toBe(0);
        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8'))
            .resolves.toBe('agent version\n');
    });

    it('executes the exact confirmed preview through the restore executor', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        const handlers = createHandlers();
        const preview = await handlers.preview({
            schemaVersion: 1,
            ...authority,
            checkpointId,
        });

        await expect(handlers.execute({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(11),
            confirmed: true,
            plan: preview,
        })).resolves.toMatchObject({
            schemaVersion: 1,
            operationId: operationId(11),
            status: 'completed',
            safetyCheckpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
            entries: [{ path: 'tracked.txt', action: 'restore', outcome: 'restored' }],
        });

        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8'))
            .resolves.toBe('before\n');
    });

    it('retries a completed rewind event after a lost acknowledgement without repeating mutation', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        let mutations = 0;
        const restoreExecutor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation) => {
                mutations += 1;
                await mutation.apply();
            },
        });
        const rewind = vi.fn()
            .mockRejectedValueOnce(new Error('checkpoint event acknowledgement lost'))
            .mockResolvedValueOnce({
                id: 'event-existing', seq: 9, createdAt: Date.now(), idempotent: true,
            });
        const handlers = createHandlers(restoreExecutor, rewind);
        const plan = await handlers.preview({ schemaVersion: 1, ...authority, checkpointId });
        const request = {
            schemaVersion: 1,
            ...authority,
            operationId: operationId(12),
            confirmed: true,
            plan,
        };

        await expect(handlers.execute(request)).rejects.toThrow('acknowledgement lost');
        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
        await expect(handlers.retry(request)).resolves.toMatchObject({ status: 'completed' });

        expect(mutations).toBe(1);
        expect(rewind).toHaveBeenCalledTimes(2);
        expect(rewind.mock.calls[1]?.[0]).toEqual(rewind.mock.calls[0]?.[0]);
        expect(rewind.mock.calls[0]?.[0]).toMatchObject({
            operationId: operationId(12),
            checkpointId,
            state: 'completed',
            files: [{ path: 'tracked.txt', action: 'modified' }],
        });
    });

    it('rejects a stale preview after a concurrent user edit', async () => {
        const checkpointId = await createAgentModifiedCheckpoint();
        const handlers = createHandlers();
        const preview = await handlers.preview({
            schemaVersion: 1,
            ...authority,
            checkpointId,
        });
        await writeFile(join(projectPath, 'tracked.txt'), 'user edit after preview\n');

        await expect(handlers.execute({
            schemaVersion: 1,
            ...authority,
            operationId: operationId(13),
            confirmed: true,
            plan: preview,
        })).resolves.toEqual({
            schemaVersion: 1,
            operationId: operationId(13),
            status: 'stale-plan',
        });

        await expect(readFile(join(projectPath, 'tracked.txt'), 'utf8'))
            .resolves.toBe('user edit after preview\n');
    });

    it('returns itemized partial results from the durable restore executor', async () => {
        const checkpointId = await createTwoFileCheckpoint();
        const attempts: string[] = [];
        let failAOnce = true;
        const restoreExecutor = new CheckpointRestoreExecutor(checkpointRoot, {
            mutate: async (mutation: CheckpointRestoreMutation) => {
                attempts.push(mutation.entry.path);
                if (mutation.entry.path === 'a.txt' && failAOnce) {
                    failAOnce = false;
                    throw new Error('injected mutation failure');
                }
                await mutation.apply();
            },
        });
        const handlers = createHandlers(restoreExecutor);
        const preview = await handlers.preview({
            schemaVersion: 1,
            ...authority,
            checkpointId,
        });
        const request = {
            schemaVersion: 1,
            ...authority,
            operationId: operationId(14),
            confirmed: true,
            plan: preview,
        } as const;

        await expect(handlers.execute(request)).resolves.toMatchObject({
            schemaVersion: 1,
            operationId: operationId(14),
            status: 'partial',
            entries: [
                { path: 'a.txt', action: 'restore', outcome: 'failed' },
                { path: 'b.txt', action: 'delete', outcome: 'deleted' },
            ],
        });
        expect(attempts).toEqual(['a.txt', 'b.txt']);

        await expect(handlers.retry(request)).resolves.toMatchObject({
            schemaVersion: 1,
            operationId: operationId(14),
            status: 'completed',
            entries: [
                { path: 'a.txt', action: 'restore', outcome: 'restored' },
                { path: 'b.txt', action: 'delete', outcome: 'deleted' },
            ],
        });
        expect(attempts).toEqual(['a.txt', 'b.txt', 'a.txt']);
    });
});
