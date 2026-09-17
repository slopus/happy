import type { SessionListViewItem, SessionRowData } from '@/sync/storage';
import type { ProjectGroupData, ProjectWorkspaceGroup } from '@/sync/projectGroups';
import {
    buildSessionProjectDisplayGroups,
    type SessionDisplayMachine,
} from '@/utils/sessionDisplayOrder';
import { getRepoPath, isWorktreePath } from '@/utils/worktreePaths';

/**
 * One checkout of a project — the project's own, or one of its worktrees —
 * and the chats running in it.
 *
 * The grouped home list lists checkouts, not chats: a checkout is where work
 * happens, and its chats open as tabs inside the session screen, the way the
 * desktop keeps them.
 *
 * Happy Agent reports project and worktree identity directly; CLI sessions get
 * the same hierarchy derived from their machine and repository path, so both
 * arrive here in the same shape.
 */
export interface ProjectWorktree {
    id: string;
    projectId: string;
    projectName: string;
    /** Empty for the project's own checkout. */
    workspaceId: string;
    /** Null for the project's own checkout, which goes by its branch instead. */
    workspaceName: string | null;
    /** What a tap opens: the chat worked on most recently. */
    session: SessionRowData;
    /**
     * Every chat in the checkout, in tab order: oldest first, so a new chat
     * joins at the end and activity never reshuffles the strip under a finger.
     */
    tabs: SessionRowData[];
    unread: boolean;
    working: boolean;
    /** Something in here is stopped on a question only the user can answer. */
    blocked: boolean;
    /** A chat in here is running on a machine that is reachable. */
    live: boolean;
    machineId: string | null;
}

/**
 * How many of a project's worktrees are drawn before the rest are summarised.
 *
 * A project accumulates worktrees without anybody deciding to let it, and a
 * dozen of them push every other project off the screen. Three is enough to
 * show that a project has several and to reach the ones being worked on, which
 * sort to the top.
 */
export const WORKTREE_PREVIEW_COUNT = 3;

/**
 * A project's card: the row that stands for the project itself. It goes by the
 * project's name alone and opens the project's own checkout, so the main chat
 * is always one tap away.
 *
 * The card carries no disclosure control. It used to, and it sat next to the
 * `+` that creates a workspace — two small round controls at the same trailing
 * edge, one adding a row and one hiding all of them. What the list shows is
 * decided by a row of its own, at the bottom of the worktrees it governs.
 */
export interface ProjectHomeEntry {
    id: string;
    name: string;
    /** The chat the card opens. Null for a project that only has worktrees. */
    session: SessionRowData | null;
    /** The own checkout's chats, in tab order. */
    tabs: SessionRowData[];
    /** Supplies the avatar — a worktree's chat when there is no own checkout. */
    avatarSession: SessionRowData | null;
    /** How many worktrees hang under the card, shown or not. */
    worktreeCount: number;
    /** The card's own checkout, which is the only thing it speaks for. */
    unread: boolean;
    working: boolean;
    blocked: boolean;
    live: boolean;
}

/**
 * The row that ends a project's worktrees: `Show all 7` while some are held
 * back, `Show less` once they are all out.
 *
 * It speaks for what it hides. A worktree stopped on a question is the reason
 * to press it, and a project with eight of them would otherwise bury that
 * behind a count.
 */
export interface WorktreeToggle {
    projectId: string;
    /** Total worktrees, which is what `Show all N` names. */
    worktreeCount: number;
    /** How many are not drawn right now. Zero while expanded. */
    hiddenCount: number;
    expanded: boolean;
    unread: boolean;
    working: boolean;
    blocked: boolean;
}

export type ProjectHomeRow =
    | { type: 'section'; id: string; label: string }
    /** Only drawn when the account reaches more than one computer. */
    | { type: 'machine'; machineId: string | null; machineName: string }
    | { type: 'bot'; session: SessionRowData }
    | { type: 'project'; project: ProjectHomeEntry }
    /** `last` closes the tree line that runs down from the project's avatar. */
    | { type: 'worktree'; worktree: ProjectWorktree; last: boolean }
    | { type: 'worktreeToggle'; toggle: WorktreeToggle }
    /**
     * The divider that opens and closes the archive. Present whenever the
     * account has something archived, so the setting that reveals it always
     * has a control on this screen and never lands on a blank one.
     */
    | { type: 'archiveToggle'; hidden: boolean }
    /** A day heading over the archived chats that follow. */
    | { type: 'archiveHeader'; title: string }
    /**
     * A retired chat. The archive is a flat chronological tail, as it is under
     * the flat layout: a retired chat belongs to no checkout in flight, and
     * its worktree is frequently no longer on disk.
     */
    | { type: 'archived'; session: SessionRowData };

interface BuildOptions {
    data: readonly SessionListViewItem[];
    machines: readonly SessionDisplayMachine[];
    unknownMachineText: string;
    /** Which projects are showing every worktree, keyed by project id. */
    expanded: Readonly<Record<string, boolean>>;
    labels: { bots: string; projects: string };
    /**
     * Whether the account has anything archived at all, which is what decides
     * if the toggle is drawn. `data` cannot say: while the archive is hidden it
     * has already been filtered out of it.
     */
    hasArchivedSessions?: boolean;
    /** The archive-visibility setting, as the toggle should report it. */
    archiveHidden?: boolean;
}

/** Checkouts are addressed through their project, which owns their names. */
export function worktreePlaceId(projectId: string, workspaceId: string): string {
    return `${projectId}\u0000${workspaceId}`;
}

/**
 * Where a new workspace for this project would be created, read off any one of
 * its chats — its own checkout's when it has one, otherwise a worktree's.
 *
 * Happy Agent owns its projects' folders, so its projects are named by catalog
 * identity; a chat inside a workspace could not point at the project's
 * directory anyway. Everything else goes by the repository path, with the
 * worktree suffix stripped so a worktree's chat still names the main checkout.
 *
 * Null when the chat says neither, which is nowhere to create anything.
 */
export function workspaceOrigin(session: SessionRowData): WorkspaceOrigin | null {
    if (!session.machineId) return null;
    if (session.projectId) {
        return { machineId: session.machineId, projectId: session.projectId, path: null };
    }
    const path = session.path?.trim() || '';
    if (!path) return null;
    return {
        machineId: session.machineId,
        projectId: null,
        path: isWorktreePath(path) ? getRepoPath(path) : path,
    };
}

export interface WorkspaceOrigin {
    machineId: string;
    /** A Happy Agent catalog project, which is named instead of a directory. */
    projectId: string | null;
    /** The project's main checkout. Null when the project is named by identity. */
    path: string | null;
}

function activityState(sessions: readonly SessionRowData[]) {
    return {
        unread: sessions.some((session) => session.hasUnread),
        working: sessions.some((session) => session.state === 'thinking'),
        blocked: sessions.some((session) => (
            session.state === 'permission_required' || session.state === 'input_required'
        )),
    };
}

function isLive(sessions: readonly SessionRowData[]): boolean {
    return sessions.some((session) => session.active && !session.machineOffline);
}

export function tabOrder(sessions: readonly SessionRowData[]): SessionRowData[] {
    return [...sessions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function toWorktree(project: ProjectGroupData, workspace: ProjectWorkspaceGroup): ProjectWorktree | null {
    // The store already sorts a checkout's chats live-first, then by activity.
    const newest = workspace.sessions[0];
    if (!newest) return null;
    return {
        id: worktreePlaceId(project.id, workspace.id),
        projectId: project.id,
        projectName: project.name,
        workspaceId: workspace.id,
        workspaceName: workspace.id === '' ? null : workspace.name ?? workspace.id,
        session: newest,
        tabs: tabOrder(workspace.sessions),
        ...activityState(workspace.sessions),
        live: isLive(workspace.sessions),
        machineId: project.machineId,
    };
}

/**
 * Lays the grouped home list out as one card per project, with that project's
 * worktrees nested under it — the project's own checkout is the card itself,
 * not a row of its own, so the main chat never hides behind a fold.
 *
 * The archive trails everything as the same flat, date-grouped tail the other
 * layout draws, behind the same toggle. It is not part of any project: this
 * screen is about work in flight, but the setting that reveals retired chats
 * has to reveal them here too, or an account with nothing but an archive
 * opens onto an empty screen.
 */
export function buildProjectHomeRows({
    data,
    machines,
    unknownMachineText,
    expanded,
    labels,
    hasArchivedSessions = false,
    archiveHidden = true,
}: BuildOptions): ProjectHomeRow[] {
    const rows: ProjectHomeRow[] = [];

    const bots = data
        .filter((item): item is Extract<SessionListViewItem, { type: 'bots' }> => item.type === 'bots')
        .flatMap((item) => item.sessions);
    if (bots.length > 0) {
        rows.push({ type: 'section', id: 'bots', label: labels.bots });
        for (const session of bots) {
            rows.push({ type: 'bot', session });
        }
    }

    const machineGroups = buildSessionProjectDisplayGroups(data, machines, unknownMachineText);
    // A single computer needs no heading: every project below it would repeat
    // the same name, and the phone screen is narrow enough already.
    const showMachineHeaders = machineGroups.length > 1;
    const projectRows: ProjectHomeRow[] = [];

    for (const group of machineGroups) {
        const machineRows: ProjectHomeRow[] = [];

        for (const { project } of group.projects) {
            const checkouts = project.workspaces
                .map((workspace) => toWorktree(project, workspace))
                .filter((checkout): checkout is ProjectWorktree => checkout !== null);
            if (checkouts.length === 0) continue;

            const primary = checkouts.find((checkout) => checkout.workspaceId === '') ?? null;
            const worktrees = checkouts.filter((checkout) => checkout.workspaceId !== '');
            // The list holds worktrees back rather than folding them, so the
            // card answers for its own checkout and nothing else. What is held
            // back is answered for by the row that holds it back.
            const ownTabs = primary?.tabs ?? [];

            machineRows.push({
                type: 'project',
                project: {
                    id: project.id,
                    name: project.name,
                    session: primary?.session ?? null,
                    tabs: ownTabs,
                    avatarSession: primary?.session ?? worktrees[0]?.session ?? null,
                    worktreeCount: worktrees.length,
                    ...activityState(ownTabs),
                    live: isLive(ownTabs),
                },
            });

            const projectExpanded = !!expanded[project.id];
            const shown = projectExpanded
                ? worktrees
                : worktrees.slice(0, WORKTREE_PREVIEW_COUNT);
            const hidden = worktrees.slice(shown.length);
            // Only worth a row when it governs something. A project sitting
            // exactly at the preview count has nothing to show or hide.
            const togglable = projectExpanded
                ? worktrees.length > WORKTREE_PREVIEW_COUNT
                : hidden.length > 0;

            shown.forEach((worktree, index) => {
                machineRows.push({
                    type: 'worktree',
                    worktree,
                    // The toggle row carries the tree line on past the last
                    // worktree, so the line only closes here without one.
                    last: !togglable && index === shown.length - 1,
                });
            });

            if (!togglable) continue;
            machineRows.push({
                type: 'worktreeToggle',
                toggle: {
                    projectId: project.id,
                    worktreeCount: worktrees.length,
                    hiddenCount: hidden.length,
                    expanded: projectExpanded,
                    ...activityState(hidden.flatMap((worktree) => worktree.tabs)),
                },
            });
        }

        if (machineRows.length === 0) continue;
        if (showMachineHeaders) {
            projectRows.push({
                type: 'machine',
                machineId: group.machineId,
                machineName: group.machineName,
            });
        }
        projectRows.push(...machineRows);
    }

    if (projectRows.length > 0) {
        rows.push({ type: 'section', id: 'projects', label: labels.projects });
        rows.push(...projectRows);
    }

    if (hasArchivedSessions) {
        rows.push({ type: 'archiveToggle', hidden: archiveHidden });
    }
    // The store already filtered these by the setting: while the archive is
    // hidden there are none to pass through. A day heading is only kept when
    // a chat follows it, so nothing heads an empty group.
    let pendingHeader: string | null = null;
    for (const item of data) {
        if (item.type === 'header') {
            pendingHeader = item.title;
            continue;
        }
        if (item.type !== 'session') continue;
        if (pendingHeader !== null) {
            rows.push({ type: 'archiveHeader', title: pendingHeader });
            pendingHeader = null;
        }
        rows.push({ type: 'archived', session: item.session });
    }

    return rows;
}

/**
 * The checkout a chat runs in, with every chat beside it — what the session
 * screen draws as its tab strip. Null for anything that is not a project chat,
 * such as a bot, which keeps the plain single-chat screen.
 */
export function findProjectWorktree(
    data: readonly SessionListViewItem[] | null,
    sessionId: string,
): ProjectWorktree | null {
    const found = locateProjectWorkspace(data, sessionId);
    return found ? toWorktree(found.project, found.workspace) : null;
}

/**
 * The same lookup without building anything — cheap enough to run inside a
 * store selector, which re-runs on every change to the store.
 */
export function locateProjectWorkspace(
    data: readonly SessionListViewItem[] | null,
    sessionId: string,
): { project: ProjectGroupData; workspace: ProjectWorkspaceGroup } | null {
    if (!data) return null;
    for (const item of data) {
        if (item.type !== 'project') continue;
        for (const workspace of item.project.workspaces) {
            if (workspace.sessions.some((session) => session.id === sessionId)) {
                return { project: item.project, workspace };
            }
        }
    }
    return null;
}
