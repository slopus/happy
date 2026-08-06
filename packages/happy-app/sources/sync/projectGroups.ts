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
 * Groups sessions without a native project identity by machine and working
 * directory. This gives Happy CLI sessions the same project-card presentation
 * as Rig without merging identical paths from different computers.
 */
export function buildPathProjectGroups(
    sessions: Session[],
    toRow: (session: Session) => SessionRowData,
    isActive: (session: Session) => boolean,
    idPrefix: string,
): ProjectGroupData[] {
    const projects = new Map<string, ProjectGroupData>();

    for (const session of sessions) {
        const machineId = session.metadata?.machineId ?? null;
        const path = session.metadata?.path?.trim() || '';
        const key = JSON.stringify([machineId, path]);
        let group = projects.get(key);
        if (!group) {
            group = {
                id: `${idPrefix}:${key}`,
                name: pathProjectName(path, session.metadata?.homeDir),
                machineId,
                workspaces: [{ id: '', name: null, sessions: [] }],
                sessionCount: 0,
                activeCount: 0,
            };
            projects.set(key, group);
        }

        group.workspaces[0].sessions.push(toRow(session));
        group.sessionCount += 1;
        if (isActive(session)) {
            group.activeCount += 1;
        }
    }

    return [...projects.values()];
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
 * Collapses Rig sessions into projects, each holding its worktrees. Sessions
 * arrive already sorted newest-first, so insertion order carries that sort
 * through to projects, worktrees, and the sessions inside them.
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
        const project = session.metadata!.project!;
        let group = projects.get(project.id);
        if (!group) {
            group = {
                id: project.id,
                name: project.name,
                machineId: session.metadata?.machineId ?? null,
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
