import {
    CheckpointExclusionGuard,
    CheckpointPolicyDriftError,
    resolveCheckpointProtectionCapability,
    type CheckpointExclusionPolicy,
    type CheckpointProvider,
} from './checkpointExclusionPolicy';
import {
    CheckpointLedger,
    type CheckpointLedgerMutationRequest,
    type CheckpointLedgerRecord,
} from './checkpointLedger';
import {
    CheckpointStore,
    type CheckpointSnapshotResult,
    type CheckpointStoreBinding,
} from './checkpointStore';

export type CheckpointRuntimeBinding = Omit<CheckpointStoreBinding, 'checkpointRoot'>;

export type CheckpointRuntimeProtection = Omit<CheckpointExclusionPolicy, 'projectPath'>;

export type CheckpointRuntimeInput = {
    provider: CheckpointProvider;
    platform: NodeJS.Platform;
    projectPath: string;
    checkpointRoot: string;
    binding: CheckpointRuntimeBinding;
    protection: CheckpointRuntimeProtection | undefined;
};

type RuntimeMutation = Pick<
    CheckpointLedgerMutationRequest,
    'operationId' | 'mutationId' | 'path' | 'action'
>;

export type CheckpointRuntime =
    | { status: 'disabled' }
    | {
        status: 'unavailable';
        reason: 'unsupported-platform' | 'unsupported-provider';
    }
    | {
        status: 'protected';
        denyWritePaths: string[];
        excludedPaths: string[];
        excludedPatterns: string[];
        readOnlyPassthroughPaths: string[];
        excludedReason(path: string): 'secret' | 'ignored' | 'too-large' | 'file-limit' | 'total-size-limit' | null;
        beforeTurn(operationId: string): Promise<CheckpointSnapshotResult>;
        recordMutation(mutation: RuntimeMutation): Promise<CheckpointLedgerRecord>;
    };

export async function createCheckpointRuntime(
    input: CheckpointRuntimeInput,
): Promise<CheckpointRuntime> {
    if (!input.protection) return { status: 'disabled' };

    const capability = resolveCheckpointProtectionCapability(input);
    if (!capability.supported) {
        return { status: 'unavailable', reason: capability.reason };
    }

    const policy = {
        projectPath: input.projectPath,
        ...input.protection,
        secretPatterns: [...input.protection.secretPatterns],
        readOnlyPassthroughPaths: [...(input.protection.readOnlyPassthroughPaths ?? [])],
    };
    let guard = await CheckpointExclusionGuard.create(policy);
    const store = new CheckpointStore(input.checkpointRoot);
    const ledger = new CheckpointLedger(input.checkpointRoot);
    const binding = {
        ...input.binding,
        projectPath: input.projectPath,
    };

    return {
        status: 'protected',
        get denyWritePaths() { return guard.manifest.denyWritePaths; },
        get excludedPaths() { return guard.manifest.excluded.map((entry) => entry.path); },
        get excludedPatterns() { return guard.secretPatterns; },
        get readOnlyPassthroughPaths() { return guard.manifest.readOnlyPassthroughPaths; },
        excludedReason: (path) => guard.excludedReason(path),
        beforeTurn: async (operationId) => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const candidate = await CheckpointExclusionGuard.create(policy);
                    const snapshot = await candidate.dispatchAfterPolicyCheck(() => store.snapshotTurn({
                        ...binding,
                        operationId,
                        excludedPaths: candidate.manifest.excluded.map((entry) => entry.path),
                        excludedPatterns: candidate.secretPatterns,
                        capturedFiles: candidate.manifest.capturedFiles,
                        validateCapture: () => candidate.dispatchAfterPolicyCheck(async () => {}),
                    }));
                    guard = candidate;
                    return snapshot;
                } catch (error) {
                    if (!(error instanceof CheckpointPolicyDriftError) || attempt === 1) throw error;
                }
            }
            throw new CheckpointPolicyDriftError();
        },
        recordMutation: (mutation) => ledger.recordMutation({
            ...binding,
            ...mutation,
        }),
    };
}
