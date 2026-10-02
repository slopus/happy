import { createHash } from 'node:crypto';
import type { CheckpointPendingDecision } from './checkpointProtectionState';
import { z } from 'zod';

const reason = z.enum(['secret', 'ignored', 'too-large', 'file-limit', 'total-size-limit']);
export class CheckpointRefreshRejectedError extends Error {}
export const checkpointRecoveryDetailSchema = z.object({
    changes: z.array(z.object({
        path: z.string().min(1).max(4096).refine(value => !value.includes('\0')
            && !/^(?:[A-Za-z]:|[\\/])/.test(value) && !value.split(/[\\/]+/).includes('..')),
        previousReason: reason.nullable(), currentReason: reason.nullable(),
        change: z.enum(['added', 'removed', 'reason-changed', 'unchanged']),
    }).strict()).max(100),
    counts: z.object({ capturedFiles: z.number().int().nonnegative(), capturedBytes: z.number().int().nonnegative(),
        excludedFiles: z.number().int().nonnegative(), totalChanges: z.number().int().nonnegative() }).strict(),
}).strict();
export type CheckpointRecoveryDetail = z.infer<typeof checkpointRecoveryDetailSchema>;

export function checkpointExclusionChanges(previous: Array<{ path: string; reason: z.infer<typeof reason> }>,
    current: Array<{ path: string; reason: z.infer<typeof reason> }>, paths?: string[]) {
    const previousByPath = new Map(previous.map(entry => [entry.path, entry.reason]));
    const currentByPath = new Map(current.map(entry => [entry.path, entry.reason]));
    const lookup = (entries: Map<string, z.infer<typeof reason>>, path: string) => entries.get(path)
        ?? [...entries].find(([parent]) => path.startsWith(`${parent}/`))?.[1] ?? null;
    return (paths ?? [...new Set([...previousByPath.keys(), ...currentByPath.keys()])]
        .filter(path => previousByPath.get(path) !== currentByPath.get(path))).sort((left, right) => left.localeCompare(right)).map(path => {
        const previousReason = lookup(previousByPath, path);
        const currentReason = lookup(currentByPath, path);
        return { path, previousReason, currentReason, change: previousReason === currentReason ? 'unchanged' as const
            : previousReason === null ? 'added' as const : currentReason === null ? 'removed' as const : 'reason-changed' as const };
    });
}

export function checkpointRecoveryRevision(pending: CheckpointPendingDecision): string {
    return createHash('sha256').update(JSON.stringify({
        operationId: pending.operationId,
        source: pending.source,
        excluded: pending.excluded,
    })).digest('hex');
}

export function checkpointRecoveryStatus(input: {
    pendingDecision: CheckpointPendingDecision | null;
    canRestoreHistory: boolean;
    limits?: { maxFileBytes: number; maxFiles: number; maxTotalBytes: number };
}) {
    const pending = input.pendingDecision;
    return {
        schemaVersion: 1 as const,
        refreshProtectedSession: true,
        canRestoreHistory: input.canRestoreHistory,
        diagnostic: pending ? {
            operationId: pending.operationId,
            revision: checkpointRecoveryRevision(pending),
            kind: pending.source === 'policy-drift' ? 'preparation-unstable' as const : 'excluded-write' as const,
            phase: pending.source === 'policy-drift' ? 'before-dispatch' as const : 'apply-partial' as const,
            excluded: pending.excluded.slice(0, 100),
            totalExcluded: pending.diagnostic?.counts.totalChanges ?? pending.excluded.length,
            limits: input.limits ?? null,
            ...(pending.diagnostic ? { changes: pending.diagnostic.changes, counts: pending.diagnostic.counts } : {}),
            providerDispatched: pending.source !== 'policy-drift',
            partialExecutionPossible: pending.source !== 'policy-drift',
        } : null,
    };
}
