import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('preserves archive lifecycle metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            startedBy: 'daemon',
            startedFromDaemon: true,
            lifecycleState: 'archived',
            lifecycleStateSince: 123,
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        });

        expect(metadata.startedBy).toBe('daemon');
        expect(metadata.startedFromDaemon).toBe(true);
        expect(metadata.lifecycleState).toBe('archived');
        expect(metadata.lifecycleStateSince).toBe(123);
        expect(metadata.archivedBy).toBe('cli');
        expect(metadata.archiveReason).toBe('User terminated');
    });

    it('preserves the Codex reconnect sync cursor', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            codexThreadId: 'thread-1',
            codexSyncCursor: {
                threadId: 'thread-1',
                turnId: 'turn-7',
            },
            codexHistoryReplay: {
                threadId: 'thread-1',
                startedAt: 123,
            },
            codexPawsOriginToken: 'opaque-origin-token',
        });

        expect(metadata.codexSyncCursor).toEqual({
            threadId: 'thread-1',
            turnId: 'turn-7',
        });
        expect(metadata.codexHistoryReplay).toEqual({
            threadId: 'thread-1',
            startedAt: 123,
        });
        expect(metadata.codexPawsOriginToken).toBe('opaque-origin-token');
    });

    it('preserves the explicit Codex account attribution', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            codexAccountProfileId: '00000000-0000-4000-8000-000000000001',
            codexAccountCredentialVersion: 3,
        });

        expect(metadata.codexAccountProfileId).toBe('00000000-0000-4000-8000-000000000001');
        expect(metadata.codexAccountCredentialVersion).toBe(3);
    });

    it('preserves worker fields and capabilities unknown to this App version', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'local-machine',
            delegatedTask: { parentSessionId: 'parent-a', taskId: 'task-a' },
            futureWorkerState: { revision: 2, ready: true },
            capabilities: { delegation: 1, futureWorkerProtocol: { version: 2 } },
        });
        expect(metadata.delegatedTask).toEqual({ parentSessionId: 'parent-a', taskId: 'task-a' });
        expect(metadata.futureWorkerState).toEqual({ revision: 2, ready: true });
        expect(metadata.capabilities).toEqual({ delegation: 1, futureWorkerProtocol: { version: 2 } });
    });

    it.each([
        { delegation: true },
        { delegation: 2 },
        { regenerateTitle: 'yes' },
        { artifactLeases: '2' },
    ])('still rejects malformed known capabilities: %j', capabilities => {
        expect(MetadataSchema.safeParse({ path: '/tmp/project', host: 'local-machine', capabilities }).success).toBe(false);
    });

    it.each([
        { path: 7 },
        { delegationProtocol: 2 },
        { codexSyncCursor: { threadId: 'thread-a', turnId: 7 } },
    ])('still rejects malformed known metadata: %j', invalid => {
        expect(MetadataSchema.safeParse({ path: '/tmp/project', host: 'local-machine', ...invalid }).success).toBe(false);
    });
});
