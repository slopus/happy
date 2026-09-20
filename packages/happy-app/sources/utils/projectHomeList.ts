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
    /**
     * The computer everything below it runs on, down to the next one of these.
     * Drawn even for an account with a single machine: the list is read as
     * "this computer, its bots, its projects", and a heading that appears only
     * once a second computer shows up makes that hierarchy look like something
     * the second computer introduced.
     */
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

/** One computer and everything of the account's that runs on it. */
interface MachineSection {
    machineId: string | null;
    machineName: string;
    /** A Happy Agent machine, as opposed to a Happy CLI daemon. */
    rig: boolean;
    bots: SessionRowData[];
    projects: ProjectHomeRow[];
    /** When this computer was last worked on, across everything under it. */
    lastActivityAt: number;
}

/**
 * Which computer comes first.
 *
 * Happy Agent's own machines lead, because they are the ones the app can start
 * work on; the CLI daemons are where work that was started in a terminal shows
 * up, and they trail. Within each, the computer worked on most recently.
 *
 * Recency is a stand-in. What was asked for is "the home machine, not the
 * team, first", and a machine has no home/team notion to read — so the list
 * leads with the one being used, which is the same machine most of the time.
 * Kept as one function so the real concept replaces it here and nowhere else.
 */
function compareMachineSections(a: MachineSection, b: MachineSection): number {
    return machineRank(a) - machineRank(b)
        || b.lastActivityAt - a.lastActivityAt
        || a.machineName.localeCompare(b.machineName);
}

function machineRank(section: MachineSection): number {
    // A chat that does not say where it runs is filed under no computer at all,
    // and that group belongs at the bottom whatever it holds.
    if (section.machineId === null) return 2;
    return section.rig ? 0 : 1;
}

/** The rows one project contributes: its card, its worktrees, and their toggle. */
function projectRows(
    project: ProjectGroupData,
    expanded: Readonly<Record<string, boolean>>,
): ProjectHomeRow[] {
    const checkouts = project.workspaces
        .map((workspace) => toWorktree(project, workspace))
        .filter((checkout): checkout is ProjectWorktree => checkout !== null);
    if (checkouts.length === 0) return [];

    const rows: ProjectHomeRow[] = [];
    const primary = checkouts.find((checkout) => checkout.workspaceId === '') ?? null;
    const worktrees = checkouts.filter((checkout) => checkout.workspaceId !== '');
    // The list holds worktrees back rather than folding them, so the card
    // answers for its own checkout and nothing else. What is held back is
    // answered for by the row that holds it back.
    const ownTabs = primary?.tabs ?? [];

    rows.push({
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
    // Only worth a row when it governs something. A project sitting exactly at
    // the preview count has nothing to show or hide.
    const togglable = projectExpanded
        ? worktrees.length > WORKTREE_PREVIEW_COUNT
        : hidden.length > 0;

    shown.forEach((worktree, index) => {
        rows.push({
            type: 'worktree',
            worktree,
            // The toggle row carries the tree line on past the last worktree,
            // so the line only closes here without one.
            last: !togglable && index === shown.length - 1,
        });
    });

    if (togglable) {
        rows.push({
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

    return rows;
}

/**
 * Lays the grouped home list out under the computer the work is on: the
 * machine, then its bots, then its projects — one card per project with that
 * project's worktrees nested under it, the project's own checkout being the
 * card itself rather than a row of its own, so the main chat never hides
 * behind a fold.
 *
 * The machine is the top level because everything under it is only reachable
 * through it: a project is a directory on one computer, and a bot is a chat
 * standing on one. A second computer brings its own bots and its own projects
 * rather than adding to a shared list of either.
 *
 * The archive trails everything as the same flat, date-grouped tail the other
 * layout draws, behind the same toggle. It belongs to no computer: a retired
 * chat's machine is frequently gone, and the tail is chronological rather than
 * grouped by anything.
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
    const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
    const sections = new Map<string | null, MachineSection>();

    const sectionFor = (machineId: string | null): MachineSection => {
        const existing = sections.get(machineId);
        if (existing) return existing;
        const machine = machineId ? machinesById.get(machineId) : undefined;
        const section: MachineSection = {
            machineId,
            machineName: machine?.metadata?.displayName
                || machine?.metadata?.host
                || (machineId ?? `<${unknownMachineText}>`),
            rig: machine?.metadata?.machineKind === 'rig',
            bots: [],
            projects: [],
            lastActivityAt: 0,
        };
        sections.set(machineId, section);
        return section;
    };

    const seen = (section: MachineSection, sessions: readonly SessionRowData[]) => {
        for (const session of sessions) {
            section.lastActivityAt = Math.max(section.lastActivityAt, session.lastActivityAt);
        }
    };

    // A bot runs on a computer like anything else, and says which one. The ones
    // that do not join the chats that could not say either.
    for (const item of data) {
        if (item.type !== 'bots') continue;
        for (const session of item.sessions) {
            const section = sectionFor(session.machineId);
            section.bots.push(session);
            seen(section, [session]);
        }
    }

    for (const group of buildSessionProjectDisplayGroups(data, machines, unknownMachineText)) {
        const section = sectionFor(group.machineId);
        for (const { project } of group.projects) {
            const built = projectRows(project, expanded);
            if (built.length === 0) continue;
            section.projects.push(...built);
            for (const workspace of project.workspaces) seen(section, workspace.sessions);
        }
    }

    for (const section of Array.from(sections.values()).sort(compareMachineSections)) {
        // A computer with nothing left on it is not worth a heading of its own.
        if (section.bots.length === 0 && section.projects.length === 0) continue;
        const key = section.machineId ?? 'unknown';
        rows.push({
            type: 'machine',
            machineId: section.machineId,
            machineName: section.machineName,
        });
        if (section.bots.length > 0) {
            rows.push({ type: 'section', id: `bots:${key}`, label: labels.bots });
            for (const session of section.bots) {
                rows.push({ type: 'bot', session });
            }
        }
        if (section.projects.length > 0) {
            rows.push({ type: 'section', id: `projects:${key}`, label: labels.projects });
            rows.push(...section.projects);
        }
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
