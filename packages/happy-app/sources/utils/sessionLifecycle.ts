import type { Metadata } from '@/sync/storageTypes';

export function isArchivedLifecycleState(state: string | null | undefined): boolean {
    return state === 'archiveRequested' || state === 'archived';
}

export function isSessionArchived(session: { metadata?: Metadata | null }): boolean {
    return isArchivedLifecycleState(session.metadata?.lifecycleState);
}

export function markSessionArchiveRequested(metadata: Metadata, now: number): Metadata {
    return {
        ...metadata,
        lifecycleState: 'archiveRequested',
        lifecycleStateSince: now,
        archivedBy: 'app',
        archiveReason: 'User archived',
    };
}

export function markSessionRestored(metadata: Metadata, now: number): Metadata {
    const {
        archivedBy: _archivedBy,
        archiveReason: _archiveReason,
        ...rest
    } = metadata;
    return {
        ...rest,
        lifecycleState: 'running',
        lifecycleStateSince: now,
    };
}
