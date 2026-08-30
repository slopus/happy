import type { Machine, Session } from './storageTypes';

/**
 * Somewhere a new session can be started: a directory, and whatever is known about it.
 *
 * `path` is what actually gets sent to the machine. `name` is what a person reads, which is the
 * project's own name when one is known and the folder otherwise.
 */
export interface SessionPlace {
    key: string;
    name: string;
    path: string;
    /** The project this place belongs to, when a Happy Agent session has named one. */
    projectId?: string;
}

/**
 * A checkout inside a project, as the picker offers it.
 *
 * Named by the workspace's own title rather than its branch, because that is the name a person
 * gave it and the name it carries everywhere else on the phone.
 */
export interface SessionWorkspace {
    id: string;
    key: string;
    name: string;
    path: string;
    projectId?: string;
}

/**
 * Whether this session has been put away.
 *
 * This is the only reason a session stops suggesting somewhere to work. Whether its machine is
 * reachable right now is a different question and deliberately not asked: a laptop that is asleep
 * still has the same projects on it, and hiding them means the picker empties itself every time a
 * daemon restarts.
 */
function isArchived(session: Session): boolean {
    return session.metadata?.lifecycleState === 'archived';
}

/**
 * Everywhere the picker may start a Happy Agent session, newest knowledge winning.
 *
 * Happy Agent runs beside Happy CLI rather than replacing it, so the directories a person already
 * works in belong to the computer, not to whichever daemon happened to open them. Both machines of
 * a pair are read, and a place named by a Happy Agent session wins over the same path derived from
 * a legacy one: the same folder, but with the project's real name attached.
 *
 * Archived sessions are left out. They describe where work used to happen, and a worktree that has
 * been put away is frequently no longer on disk.
 */
export function collectSessionPlaces(options: {
    machineIds: readonly string[];
    sessions: readonly Session[];
    /** Kept first so the picker always offers what is currently selected. */
    selectedPath?: string | null;
}): SessionPlace[] {
    const machineIds = new Set(options.machineIds.filter((id) => id.length > 0));
    const byPath = new Map<string, SessionPlace>();

    const remember = (place: SessionPlace, named: boolean): void => {
        const existing = byPath.get(place.path);
        // A named place replaces a bare path; a bare path never replaces a named one.
        if (existing !== undefined && (!named || existing.projectId !== undefined)) return;
        byPath.set(place.path, place);
    };

    const selected = options.selectedPath?.trim();
    if (selected !== undefined && selected.length > 0) {
        remember({ key: selected, name: selected, path: selected }, false);
    }

    for (const session of options.sessions) {
        const metadata = session.metadata;
        const path = metadata?.path?.trim();
        if (path === undefined || path.length === 0) continue;
        if (metadata?.machineId !== undefined && !machineIds.has(metadata.machineId)) continue;
        if (isArchived(session)) continue;

        const project = metadata?.project;
        // A session running in a workspace reports the workspace's directory, and a project
        // publishes no path of its own, so such a session can say nothing about where its project
        // lives. Offering the checkout here instead would put a worktree in the project list.
        if (metadata?.workspace !== undefined) continue;
        if (project !== undefined && project.id.length > 0) {
            remember(
                { key: path, name: project.name, path, projectId: project.id },
                true,
            );
            continue;
        }
        remember({ key: path, name: path, path }, false);
    }

    return [...byPath.values()];
}

/**
 * The workspaces a person may start a session in, for the project at this path.
 *
 * Read from the sessions Happy Agent published rather than from git, so a workspace is named the
 * way it was named on the desktop, and one whose checkout has been archived away is not offered.
 */
export function collectSessionWorkspaces(options: {
    machineIds: readonly string[];
    projectId?: string | null;
    sessions: readonly Session[];
}): SessionWorkspace[] {
    const projectId = options.projectId?.trim();
    if (projectId === undefined || projectId.length === 0) return [];
    const machineIds = new Set(options.machineIds.filter((id) => id.length > 0));
    const byId = new Map<string, SessionWorkspace>();

    for (const session of options.sessions) {
        const metadata = session.metadata;
        const workspace = metadata?.workspace;
        const path = metadata?.path?.trim();
        if (workspace === undefined || path === undefined || path.length === 0) continue;
        if (metadata?.project?.id !== projectId) continue;
        if (metadata?.machineId !== undefined && !machineIds.has(metadata.machineId)) continue;
        if (isArchived(session)) continue;
        if (byId.has(workspace.id)) continue;
        byId.set(workspace.id, {
            id: workspace.id,
            key: path,
            name: workspace.name,
            path,
            projectId,
        });
    }

    return [...byId.values()];
}

/**
 * The machines that are really one computer, so the places on it are offered once.
 *
 * Happy gives each daemon its own machine, and Happy Agent names the other half of its pair. A
 * person picking Happy Agent should still see the directories their Happy CLI sessions established.
 */
export function pairedMachineIds(
    machine: Machine | null | undefined,
    machines: readonly Machine[],
): string[] {
    if (!machine) return [];
    const ids = new Set<string>([machine.id]);
    const sibling = (machine.metadata as { siblingMachineId?: unknown } | null | undefined)
        ?.siblingMachineId;
    if (typeof sibling === 'string' && sibling.length > 0) ids.add(sibling);
    // The pointer is written by Happy Agent only, so the pairing is also read backwards.
    for (const candidate of machines) {
        const pointer = (candidate.metadata as { siblingMachineId?: unknown } | null | undefined)
            ?.siblingMachineId;
        if (typeof pointer === 'string' && pointer === machine.id) ids.add(candidate.id);
    }
    return [...ids];
}
