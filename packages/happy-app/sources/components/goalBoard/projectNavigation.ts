import { createRouteHistory, applyRouteHistoryPathname, type RouteHistoryState } from '@/navigation/browserNavigation';

const keys = ['machine', 'project', 'feature', 'task', 'conversation', 'author', 'view', 'file'] as const;
export type ProjectLocation = Partial<Record<typeof keys[number], string>>;

export function projectLocationKey(location: ProjectLocation) {
    return JSON.stringify(Object.fromEntries(keys.flatMap(key => location[key] ? [[key, location[key]]] : [])));
}

export function projectHistoryLocation(history: RouteHistoryState): ProjectLocation {
    const location = JSON.parse(history.stack[history.cursor]) as ProjectLocation;
    // setParams merges: send cleared keys too, so Back cannot retain a later conversation.
    return Object.fromEntries(keys.map(key => [key, location[key]]));
}

export const createProjectHistory = (location: ProjectLocation) => createRouteHistory(projectLocationKey(location));

export function pushProjectLocation(history: RouteHistoryState, patch: ProjectLocation) {
    return applyRouteHistoryPathname(history, projectLocationKey({ ...projectHistoryLocation(history), ...patch }), null);
}

export function moveProjectHistory(history: RouteHistoryState, direction: -1 | 1): RouteHistoryState {
    const cursor = Math.max(0, Math.min(history.stack.length - 1, history.cursor + direction));
    return cursor === history.cursor ? history : { ...history, cursor };
}
