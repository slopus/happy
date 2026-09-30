import type { Metadata } from '@/api/types';

/** Merge the daemon's freshly fetched server metadata into this worker's
 * process-local fields. The persisted sync cursor must be present before
 * thread history replay starts; waiting for a later socket update is racy. */
export function mergeReconnectMetadata(
    localMetadata: Metadata,
    serializedServerMetadata: string | undefined,
): Metadata {
    if (!serializedServerMetadata) return localMetadata;

    try {
        const parsed = JSON.parse(serializedServerMetadata) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return localMetadata;
        }
        return {
            ...localMetadata,
            ...(parsed as Metadata),
            hostPid: localMetadata.hostPid,
            startedFromDaemon: localMetadata.startedFromDaemon,
            startedBy: localMetadata.startedBy,
            lifecycleState: 'running',
            lifecycleStateSince: Date.now(),
            archivedBy: undefined,
            archiveReason: undefined,
        };
    } catch {
        return localMetadata;
    }
}

/** metadata 版本冲突后仍以当前 worker 的身份与恢复能力完成重连。 */
export function applyCodexReconnectUpdate(current: Metadata, worker: Metadata): Metadata {
    return {
        ...current,
        hostPid: worker.hostPid,
        startedBy: worker.startedBy,
        startedFromDaemon: worker.startedFromDaemon,
        capabilities: { ...current.capabilities, ...worker.capabilities },
        codexAccountProfileId: worker.codexAccountProfileId,
        codexAccountCredentialVersion: worker.codexAccountCredentialVersion,
        codexPawsOriginToken: current.codexPawsOriginToken ?? worker.codexPawsOriginToken,
        lifecycleState: 'running',
        archivedBy: undefined,
    };
}
