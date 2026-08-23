import type { SessionListViewItem, SessionRowData } from '@/sync/storage';
import { getRepoPath, getWorktreeName, isWorktreePath } from '@/utils/worktreePaths';

/**
 * One session as the flat home list shows it: the session's own title, and the
 * project/worktree it belongs to spelled out on the row instead of being
 * implied by a card it sits inside.
 */
export interface FlatSessionRowData {
    session: SessionRowData;
    projectName: string;
    /** Null in a project's primary checkout, which needs no second name. */
    workspaceName: string | null;
}

/**
 * Flattens the project cards into one chronological list.
 *
 * Grouping by project is what loses the global ordering: sessions are sorted
 * once, then dealt into projects, so a project's older sessions end up directly
 * under its newest one. The flat list wants what the user last touched at the
 * top regardless of project, so it re-sorts the rows here.
 *
 * Archived rows (`type: 'session'`) and the headings above them are left alone
 * — they are already a flat, date-grouped tail that the caller appends.
 */
export function buildFlatSessionRows(
    items: readonly SessionListViewItem[],
    options: { sortByActivity: boolean },
): FlatSessionRowData[] {
    const rows: FlatSessionRowData[] = [];

    for (const item of items) {
        if (item.type === 'active-sessions') {
            for (const session of item.sessions) {
                rows.push(toFlatSessionRow(session));
            }
            continue;
        }
        if (item.type !== 'project') continue;
        for (const workspace of item.project.workspaces) {
            for (const session of workspace.sessions) {
                rows.push({
                    session,
                    projectName: item.project.name,
                    workspaceName: workspace.name ?? (workspace.id || null),
                });
            }
        }
    }

    const sortKey = options.sortByActivity
        ? (row: FlatSessionRowData) => row.session.lastActivityAt
        : (row: FlatSessionRowData) => row.session.createdAt;

    return rows.sort((a, b) => {
        const activeDelta = Number(b.session.active) - Number(a.session.active);
        return activeDelta !== 0 ? activeDelta : sortKey(b) - sortKey(a);
    });
}

/**
 * Places a session that reached the list without a project card around it —
 * an archived row, or one of the active-sessions rows — using the same rule the
 * card grouping uses: a worktree names its repository as the project and itself
 * as the workspace.
 */
export function toFlatSessionRow(session: SessionRowData): FlatSessionRowData {
    const path = session.path?.trim() || '';
    const worktree = isWorktreePath(path);
    const projectPath = worktree ? getRepoPath(path) : path;
    return {
        session,
        projectName: session.projectName
            ?? projectPath.split(/[\\/]/).filter(Boolean).at(-1)
            ?? '',
        workspaceName: session.workspaceName ?? (worktree ? getWorktreeName(path) : null),
    };
}
