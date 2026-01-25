import { describe, expect, it } from 'vitest';

import { mergeSessionMetadataForStartup } from './mergeSessionMetadataForStartup';

describe('mergeSessionMetadataForStartup', () => {
    it('seeds messageQueueV1 when missing', () => {
        const nowMs = 123;
        const merged = mergeSessionMetadataForStartup({
            current: { lifecycleState: 'archived' } as any,
            next: { hostPid: 1 } as any,
            nowMs,
        });

        expect(merged.messageQueueV1).toEqual({ v: 1, queue: [] });
        expect(merged.lifecycleState).toBe('running');
        expect(merged.lifecycleStateSince).toBe(nowMs);
    });

    it('preserves existing messageQueueV1 contents when next metadata seeds an empty queue', () => {
        const nowMs = 999;
        const merged = mergeSessionMetadataForStartup({
            current: { messageQueueV1: { v: 1, queue: [{ localId: 'a' }] } } as any,
            next: { messageQueueV1: { v: 1, queue: [] } } as any,
            nowMs,
        });

        expect(merged.messageQueueV1?.queue).toEqual([{ localId: 'a' }]);
    });

    it('prefers next messageQueueV1 when current is invalid', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: { messageQueueV1: { v: 0, queue: 'nope' } } as any,
            next: { messageQueueV1: { v: 1, queue: [{ localId: 'b' }] } } as any,
            nowMs,
        });

        expect(merged.messageQueueV1?.queue).toEqual([{ localId: 'b' }]);
    });

    it('preserves existing provider resume ids when next does not define them', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: { geminiSessionId: 'g1', codexSessionId: 'c1' } as any,
            next: { hostPid: 2 } as any,
            nowMs,
        });

        expect((merged as any).geminiSessionId).toBe('g1');
        expect((merged as any).codexSessionId).toBe('c1');
        expect(merged.hostPid).toBe(2);
    });

    it('preserves permissionMode when no override is provided', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 10 } as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 20 } as any,
            nowMs,
        });

        expect(merged.permissionMode).toBe('ask');
        expect(merged.permissionModeUpdatedAt).toBe(10);
    });

    it('applies explicit permissionMode override when it is newer than existing metadata', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 10 } as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 20 } as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 25 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(25);
    });

    it('ensures permissionModeUpdatedAt is monotonic when an override is provided with an older timestamp', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 100 } as any,
            next: {} as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 1 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(101);
    });
});

