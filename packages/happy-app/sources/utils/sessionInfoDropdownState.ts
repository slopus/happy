export type SessionInfoExpandedRow = 'permission' | 'model' | 'effort' | null;

export type SessionInfoEditability = {
    permission: boolean;
    model: boolean;
    effort: boolean;
};

/**
 * An expanded option list is only valid while its row can still be edited.
 * In particular, a connection loss must hide the list immediately instead of
 * leaving focusable options whose handlers can only no-op.
 */
export function canKeepSessionInfoExpansion(
    expanded: SessionInfoExpandedRow,
    editability: SessionInfoEditability,
): boolean {
    if (expanded === null) {
        return true;
    }
    return editability[expanded];
}
