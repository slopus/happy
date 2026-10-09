import { isApplicationSession } from '@slopus/happy-wire';
import type { AgentState, Metadata } from '@/sync/storageTypes';

type ArchiveSession = {
    metadata?: Metadata | null;
    agentState?: AgentState | null;
    thinking?: boolean;
    draft?: string | null;
    hasPendingLocalMessages?: boolean;
};

export function isArchivedLifecycleState(state: string | null | undefined): boolean {
    return state === 'archiveRequested' || state === 'archived';
}

/** Automatic application archive uses the durable root-turn outcome. It only
 * changes list membership: the processor stays warm and may accept a followup.
 * Explicit lifecycle archives still stop execution through the existing path. */
export function isSessionArchived(session: ArchiveSession): boolean {
    if (isArchivedLifecycleState(session.metadata?.lifecycleState)) return true;
    if (!isApplicationSession(session.metadata) || session.thinking || session.draft?.trim()
        || session.hasPendingLocalMessages) return false;
    const state = session.agentState;
    if (state?.turnStatus?.status !== 'completed' || (state.queuedMessages ?? 0) > 0
        || Object.keys(state.requests ?? {}).length > 0) return false;
    const restored = session.metadata.applicationArchiveRestoredThrough;
    return !restored || restored.updatedAt !== state.turnStatus.updatedAt
        || restored.turnId !== state.turnStatus.turnId;
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

export function markSessionRestored(metadata: Metadata, now: number, turn?: AgentState['turnStatus']): Metadata {
    const {
        archivedBy: _archivedBy,
        archiveReason: _archiveReason,
        ...rest
    } = metadata;
    return {
        ...rest,
        lifecycleState: 'running',
        lifecycleStateSince: now,
        ...(isApplicationSession(metadata) && turn?.status === 'completed' ? {
            applicationArchiveRestoredThrough: { updatedAt: turn.updatedAt, ...(turn.turnId ? { turnId: turn.turnId } : {}) },
        } : {}),
    };
}
