export function isArchivedSession(session: { active?: boolean; archivedAt?: number | null }): boolean {
    return session.archivedAt != null;
}
