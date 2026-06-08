type ArchiveStateInput = {
    active?: boolean;
    archivedAt?: number | null;
    lifecycleState?: string | null;
    metadata?: {
        lifecycleState?: string | null;
    } | null;
};

const LEGACY_ARCHIVED_LIFECYCLE_STATES = new Set(["archiveRequested", "archived"]);

export function isArchivedSession(session: ArchiveStateInput): boolean {
    if (session.archivedAt != null) {
        return true;
    }

    const lifecycleState = session.lifecycleState ?? session.metadata?.lifecycleState;
    return lifecycleState != null && LEGACY_ARCHIVED_LIFECYCLE_STATES.has(lifecycleState);
}
