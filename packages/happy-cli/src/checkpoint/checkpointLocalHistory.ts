import { randomUUID } from 'node:crypto';
import type { CheckpointEventPublisher } from './checkpointEventPublisher';
import type { CheckpointProvider } from './checkpointExclusionPolicy';
import { CheckpointStore, type CheckpointStoreBinding } from './checkpointStore';

/** specs/checkpoint-local-history R2 — files over this size stay unrecorded (and writable). */
export const LOCAL_HISTORY_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Saycode's own worktrees live inside the main checkout; each records its own history. */
export const LOCAL_HISTORY_ALWAYS_EXCLUDED = ['.aplus/worktrees/'];

export type CheckpointLocalHistoryTurn = {
    operationId: string;
    checkpointId: string;
    /** The folder the provider works in: the original one, never a copy. */
    providerPath: string;
};

export type CheckpointLocalHistory = {
    /** The dispatch gate: records the folder and acknowledges the event before the turn may run. */
    beforeTurn(): Promise<CheckpointLocalHistoryTurn>;
    /** Records what the turn left, so a later restore can tell its changes from anyone else's. */
    afterTurn(): Promise<void>;
};

export type CheckpointLocalHistoryCapability =
    | { supported: true }
    | { supported: false; reason: 'unsupported-platform' | 'unsupported-provider' };

export function resolveCheckpointLocalHistoryCapability(input: {
    platform: NodeJS.Platform;
    provider: CheckpointProvider;
}): CheckpointLocalHistoryCapability {
    if (input.platform !== 'darwin' && input.platform !== 'linux') {
        return { supported: false, reason: 'unsupported-platform' };
    }
    if (input.provider !== 'claude-remote' && input.provider !== 'codex') {
        return { supported: false, reason: 'unsupported-provider' };
    }
    return { supported: true };
}

export function createCheckpointLocalHistory(input: {
    binding: Omit<CheckpointStoreBinding, 'checkpointRoot'>;
    checkpointRoot: string;
    projectPath: string;
    secretPatterns: string[];
    checkpointEvents: Pick<CheckpointEventPublisher, 'snapshot'>;
}): CheckpointLocalHistory {
    const store = new CheckpointStore(input.checkpointRoot);
    const record = (operationId: string, kind: 'before' | 'after') => store.snapshotTurn({
        ...input.binding,
        projectPath: input.projectPath,
        operationId,
        excludedPatterns: [...input.secretPatterns, ...LOCAL_HISTORY_ALWAYS_EXCLUDED],
        workTree: { maxFileBytes: LOCAL_HISTORY_MAX_FILE_BYTES, record: kind },
    });
    // A gate that failed before its event was acknowledged retries the same operation, so the
    // record and the event stay one-to-one.
    let pendingOperationId: string | null = null;
    let lastOperationId: string | null = null;
    return {
        beforeTurn: async () => {
            const operationId = pendingOperationId ?? randomUUID();
            pendingOperationId = operationId;
            const snapshot = await record(operationId, 'before');
            await input.checkpointEvents.snapshot({ operationId, checkpointId: snapshot.checkpointId, excluded: [] });
            pendingOperationId = null;
            lastOperationId = operationId;
            return { operationId, checkpointId: snapshot.checkpointId, providerPath: input.projectPath };
        },
        afterTurn: async () => {
            if (!lastOperationId) return;
            await record(`${lastOperationId}:after`, 'after');
        },
    };
}
