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
            codexPawsOriginToken: 'opaque-origin-token',
        });

        expect(metadata.codexSyncCursor).toEqual({
            threadId: 'thread-1',
            turnId: 'turn-7',
        });
        expect(metadata.codexPawsOriginToken).toBe('opaque-origin-token');
    });
});
