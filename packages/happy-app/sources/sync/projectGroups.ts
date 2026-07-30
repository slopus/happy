import type { Session } from './storageTypes';
import type { SessionRowData } from './storage';

// One git worktree inside a Rig project. `id` is empty and `name` is null for
// the project's primary tree, which always sorts first.
export interface ProjectWorkspaceGroup {
    id: string;
    name: string | null;
    sessions: SessionRowData[];
}

// A Rig project: every worktree of the same repo, shown together.
export interface ProjectGroupData {
    id: string;
    name: string;
    machineId: string | null;
    workspaces: ProjectWorkspaceGroup[];
    sessionCount: number;
    activeCount: number;
}

/**
 * Rig reports a project (and optionally a worktree) for every session it runs;
 * the Happy CLI does not. Only Rig sessions get the project presentation, so
 * that CLI sessions keep the flat, date-grouped list they have always had.
 */
export function isProjectSession(session: Session): boolean {
    return !!session.metadata?.project?.id;
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
