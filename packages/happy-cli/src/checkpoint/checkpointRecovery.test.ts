import { describe, expect, it } from 'vitest';
import { checkpointExclusionChanges, checkpointRecoveryDetailSchema, checkpointRecoveryRevision, checkpointRecoveryStatus } from './checkpointRecovery';
import type { CheckpointPendingDecision } from './checkpointProtectionState';

const pending: CheckpointPendingDecision = {
    operationId: '123e4567-e89b-42d3-a456-123456789012',
    source: 'policy-drift',
    excluded: [{ path: 'large.bin', reason: 'too-large' }],
    warnings: { partialExecutionPossible: true, externalSideEffectsMayRepeat: true },
};

describe('checkpoint recovery diagnostics', () => {
    it('describes additions, removals, reason changes and nested actual targets', () => {
        expect(checkpointExclusionChanges([{ path: 'old', reason: 'secret' }, { path: 'cache', reason: 'ignored' }],
            [{ path: 'new', reason: 'too-large' }, { path: 'cache', reason: 'secret' }]))
            .toEqual([
                { path: 'cache', previousReason: 'ignored', currentReason: 'secret', change: 'reason-changed' },
                { path: 'new', previousReason: null, currentReason: 'too-large', change: 'added' },
                { path: 'old', previousReason: 'secret', currentReason: null, change: 'removed' },
            ]);
        expect(checkpointExclusionChanges([], [{ path: 'cache', reason: 'ignored' }], ['cache/new.txt']))
            .toEqual([{ path: 'cache/new.txt', previousReason: null, currentReason: 'ignored', change: 'added' }]);
    });
    it('distinguishes an undispatched preparation from an actual excluded write', () => {
        expect(checkpointRecoveryStatus({ pendingDecision: pending, canRestoreHistory: false }).diagnostic)
            .toMatchObject({ phase: 'before-dispatch', kind: 'preparation-unstable' });
        expect(checkpointRecoveryStatus({ pendingDecision: { ...pending, source: 'turn-apply' }, canRestoreHistory: false }).diagnostic)
            .toMatchObject({ phase: 'apply-partial', kind: 'excluded-write' });
    });

    it('binds the revision to the operation, source and exclusions and bounds display paths', () => {
        expect(checkpointRecoveryRevision({ ...pending, source: 'turn-apply' })).not.toBe(checkpointRecoveryRevision(pending));
        const status = checkpointRecoveryStatus({
            pendingDecision: { ...pending, excluded: Array.from({ length: 101 }, (_, index) => ({ path: `${index}.bin`, reason: 'too-large' })) },
            canRestoreHistory: false,
        });
        expect(status.diagnostic?.excluded).toHaveLength(100);
        expect(status.diagnostic?.totalExcluded).toBe(101);
    });

    it('accepts legal file names with control characters but still rejects NUL', () => {
        const detail = (path: string) => ({
            changes: [{ path, previousReason: null, currentReason: 'ignored', change: 'added' }],
            counts: { capturedFiles: 1, capturedBytes: 1, excludedFiles: 1, totalChanges: 1 },
        });
        expect(checkpointRecoveryDetailSchema.safeParse(detail('Icon\r')).success).toBe(true);
        expect(checkpointRecoveryDetailSchema.safeParse(detail('big\tdata.bin')).success).toBe(true);
        expect(checkpointRecoveryDetailSchema.safeParse(detail('bad\0name')).success).toBe(false);
    });
});
