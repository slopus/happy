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
