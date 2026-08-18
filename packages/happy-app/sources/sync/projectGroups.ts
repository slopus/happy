import type { Session } from './storageTypes';
import type { SessionRowData } from './storage';

// One git worktree inside a project. `id` is empty and `name` is null for
// the project's primary tree, which always sorts first.
export interface ProjectWorkspaceGroup {
    id: string;
    name: string | null;
    sessions: SessionRowData[];
}

// A project shown in the sessions sidebar. Rig supplies a durable project
// identity; Happy CLI sessions use their machine and working directory.
export interface ProjectGroupData {
    id: string;
    name: string;
    machineId: string | null;
    workspaces: ProjectWorkspaceGroup[];
    sessionCount: number;
    activeCount: number;
}

/**
 * Rig reports a project (and optionally a worktree) for its current sessions.
 */
export function isProjectSession(session: Session): boolean {
    return !!session.metadata?.project?.id;
}

/**
 * The project a session belongs to.
 *
 * Identity is the project's NAME — Rig's native project name when the session
 * carries one, the working directory's last segment otherwise. Runtime and
 * machine are deliberately not part of it: the same repository reached through
 * Rig, through Happy CLI, or through a second daemon on the same box is one
 * project, and splitting it three ways buried the work under bookkeeping. The
 * price is that genuinely different repositories sharing a folder name merge
 * into one card — accepted, a single legible list is worth more here than a
 * distinction almost nobody hits.
 */
function projectIdentity(session: Session): { id: string; name: string; machineId: string | null } {
    const machineId = session.metadata?.machineId ?? null;
    const name = session.metadata?.project?.name?.trim()
        || pathProjectName(session.metadata?.path?.trim() || '', session.metadata?.homeDir);
    return { id: `project:${name.toLowerCase()}`, name, machineId };
}

function pathProjectName(path: string, homeDir: string | undefined): string {
    const normalizedPath = path.replace(/[\\/]+$/, '');
    const normalizedHome = homeDir?.replace(/[\\/]+$/, '');
    if (!normalizedPath || normalizedPath === '~' || normalizedPath === normalizedHome) {
        return 'Home';
    }
    return normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) ?? normalizedPath;
}

/** Keeps only the rows accepted by a visibility rule and refreshes its badge. */
export function filterProjectGroupSessions(
    project: ProjectGroupData,
    keep: (session: SessionRowData) => boolean,
): ProjectGroupData | null {
    const workspaces = project.workspaces
        .map((workspace) => ({
            ...workspace,
            sessions: workspace.sessions.filter(keep),
        }))
        .filter((workspace) => workspace.sessions.length > 0);
    if (workspaces.length === 0) return null;

    const sessions = workspaces.flatMap((workspace) => workspace.sessions);
    return {
        ...project,
        workspaces,
        sessionCount: sessions.length,
        activeCount: sessions.filter((session) => session.active).length,
    };
}

/**
 * Collapses sessions into projects, each holding its worktrees. Rig and Happy
 * CLI sessions go through the same pass and land in one list — the runtime is
 * not a grouping level, only an ingredient of a project's identity.
 *
 * Sessions arrive already sorted newest-first, so insertion order carries that
 * sort through to projects, worktrees, and the sessions inside them.
 *
 * `toRow` and `isActive` are injected so this module stays free of the React
 * Native imports that `storage.ts` pulls in.
 */
export function buildProjectGroups(
    sessions: Session[],
    toRow: (session: Session) => SessionRowData,
    isActive: (session: Session) => boolean,
): ProjectGroupData[] {
    const projects = new Map<string, ProjectGroupData>();
    const workspaces = new Map<string, ProjectWorkspaceGroup>();

    for (const session of sessions) {
        const project = projectIdentity(session);
        let group = projects.get(project.id);
        if (!group) {
            group = {
                id: project.id,
                name: project.name,
                machineId: project.machineId,
                workspaces: [],
                sessionCount: 0,
                activeCount: 0,
            };
            projects.set(project.id, group);
        }

        const workspace = session.metadata?.workspace;
        const workspaceId = workspace?.id ?? '';
        const workspaceKey = `${project.id}\u0000${workspaceId}`;
        let workspaceGroup = workspaces.get(workspaceKey);
        if (!workspaceGroup) {
            workspaceGroup = { id: workspaceId, name: workspace?.name ?? null, sessions: [] };
            workspaces.set(workspaceKey, workspaceGroup);
            group.workspaces.push(workspaceGroup);
        }

        workspaceGroup.sessions.push(toRow(session));
        group.sessionCount += 1;
        if (isActive(session)) {
            group.activeCount += 1;
        }
    }

    // The primary tree leads, the rest keep newest-first order.
    for (const group of projects.values()) {
        const primaryIndex = group.workspaces.findIndex(w => w.id === '');
        if (primaryIndex > 0) {
            const [primary] = group.workspaces.splice(primaryIndex, 1);
            group.workspaces.unshift(primary);
        }
    }

    return [...projects.values()];
}

/** The session fields the sessions-list search box looks at. */
export function sessionMatchesQuery(session: SessionRowData, normalizedQuery: string): boolean {
    return [
        session.name,
        session.subtitle,
        session.path,
        session.machineId,
        session.flavor,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
}

/**
 * Narrows a project to what matches a search query, or drops it entirely.
 *
 * Projects hold their sessions nested inside worktrees, so the flat filter the
 * list applies to ordinary sessions cannot see them: without this every Rig
 * project disappeared as soon as anything was typed. Matching the project or a
 * worktree by name keeps everything under it, so a search for a repo still
 * shows the whole repo. Counts are recomputed so the badge agrees with the rows
 * that are actually left.
 */
export function filterProjectGroup(
    project: ProjectGroupData,
    normalizedQuery: string,
): ProjectGroupData | null {
    if (project.name.toLocaleLowerCase().includes(normalizedQuery)) {
        return project;
    }

    const workspaces = project.workspaces
        .map((workspace) => (
            workspace.name?.toLocaleLowerCase().includes(normalizedQuery)
                ? workspace
                : { ...workspace, sessions: workspace.sessions.filter((s) => sessionMatchesQuery(s, normalizedQuery)) }
        ))
        .filter((workspace) => workspace.sessions.length > 0);

    if (workspaces.length === 0) {
        return null;
    }

    const sessions = workspaces.flatMap((workspace) => workspace.sessions);
    return {
        ...project,
        workspaces,
        sessionCount: sessions.length,
        activeCount: sessions.filter((session) => session.active).length,
    };
}
