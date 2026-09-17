import type { Machine, Session } from './storageTypes';

/**
 * Somewhere a new session can be started: a directory, or a project, and whatever is known about it.
 *
 * `path` is what actually gets sent to the machine. `name` is what a person reads, which is the
 * project's own name when one is known and the folder otherwise.
 *
 * `path` is null for a project that has only ever been worked on inside its workspaces. Nothing on
 * the phone knows such a project's folder — only Happy Agent's catalog does — so it is offered by
 * identity instead, which is what the native spawn wants anyway.
 */
export interface SessionPlace {
    key: string;
    name: string;
    path: string | null;
    /** The project this place belongs to, when a Happy Agent session has named one. */
    projectId?: string;
}

const PROJECT_PLACE_PREFIX = 'project:';

/** How a project whose folder only the catalog knows is named in the picker and the draft. */
export function projectPlaceKey(projectId: string): string {
    return `${PROJECT_PLACE_PREFIX}${projectId}`;
}

/** The project a place key names, or null when the key is an ordinary directory. */
export function readProjectPlaceKey(key: string): string | null {
    return key.startsWith(PROJECT_PLACE_PREFIX)
        ? key.slice(PROJECT_PLACE_PREFIX.length) || null
        : null;
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
 *
 * A project worked on only inside its workspaces is offered too, by identity rather than by path.
 * It appears on the home screen like any other, and leaving it out of the picker left a project a
 * person could see but not start anything in.
 */
export function collectSessionPlaces(options: {
    machineIds: readonly string[];
    sessions: readonly Session[];
    /** Kept first so the picker always offers what is currently selected. */
    selectedPath?: string | null;
}): SessionPlace[] {
    const machineIds = new Set(options.machineIds.filter((id) => id.length > 0));
    const byPath = new Map<string, SessionPlace>();
    /** Projects met only through a checkout inside them, which says nothing about their folder. */
    const byProject = new Map<string, string>();
    const projectsWithPath = new Set<string>();

    const remember = (place: SessionPlace & { path: string }, named: boolean): void => {
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
        if (metadata?.bot) continue;
        const path = metadata?.path?.trim();
        if (path === undefined || path.length === 0) continue;
        if (metadata?.machineId !== undefined && !machineIds.has(metadata.machineId)) continue;
        if (isArchived(session)) continue;

        const project = metadata?.project;
        // A session running in a workspace reports the workspace's directory, and a project
        // publishes no path of its own, so such a session can say nothing about where its project
        // lives. Offering the checkout here would put a worktree in the project list, so the
        // project is remembered by identity instead and offered without a path below.
        if (metadata?.workspace !== undefined) {
            if (project !== undefined && project.id.length > 0) {
                byProject.set(project.id, project.name);
            }
            continue;
        }
        if (project !== undefined && project.id.length > 0) {
            projectsWithPath.add(project.id);
            remember(
                { key: path, name: project.name, path, projectId: project.id },
                true,
            );
            continue;
        }
        remember({ key: path, name: path, path }, false);
    }

    const places = [...byPath.values()];
    for (const [projectId, name] of byProject) {
        // A project whose own checkout is already offered needs no second row: that place carries
        // the same identity, and it can also be started in as a plain directory.
        if (projectsWithPath.has(projectId)) continue;
        places.push({ key: projectPlaceKey(projectId), name, path: null, projectId });
    }
    return places;
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
        if (metadata?.bot) continue;
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
