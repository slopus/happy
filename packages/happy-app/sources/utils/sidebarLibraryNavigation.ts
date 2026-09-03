import type { SessionRowData } from '@/sync/storage';
import type { SidebarList, SidebarOrganization } from '@/sync/sidebarOrganization';
import type { Machine } from '@/sync/storageTypes';
import {
    buildSessionNavigationGroups,
    type SessionNavigationProjectGroup,
} from '@/utils/sessionNavigationGroups';
import { partitionSessionsByPinnedOrder } from '@/utils/sessionPinning';

export type SidebarLibrarySelection =
    | { kind: 'timeline' }
    | { kind: 'pinned' }
    | { kind: 'project'; key: string; machineId: string; path: string }
    | { kind: 'list'; id: string }
    | { kind: 'unassigned' }
    | { kind: 'tag'; id: string };

export type SidebarLibraryProject = SessionNavigationProjectGroup & {
    machineId: string;
    machineName: string;
};

export type SidebarLibraryFolderGroup = {
    folderId: string | null;
    name: string | null;
    lists: SidebarList[];
};

export function collectSidebarSessions(data: Array<{
    type: string;
    session?: SessionRowData;
    sessions?: SessionRowData[];
}> | null): SessionRowData[] {
    if (!data) return [];
    const byId = new Map<string, SessionRowData>();
    for (const item of data) {
        if (item.type === 'active-sessions') {
            item.sessions?.forEach((session) => byId.set(session.id, session));
        } else if (item.type === 'session' && item.session) {
            byId.set(item.session.id, item.session);
        }
    }
    return Array.from(byId.values());
}

export function buildSidebarLibraryProjects({
    machines,
    pinnedOrder,
    sessions,
    unknownLabel,
}: {
    machines: Machine[];
    pinnedOrder: string[];
    sessions: SessionRowData[];
    unknownLabel: string;
}): SidebarLibraryProject[] {
    const { regular } = partitionSessionsByPinnedOrder(sessions, pinnedOrder);
    return buildSessionNavigationGroups({ machines, pinnedOrder, sessions: regular, unknownLabel })
        .flatMap((machine) => machine.projects.map((project) => ({
            ...project,
            machineId: machine.machineId,
            machineName: machine.machineName,
        })));
}

export function buildSidebarLibraryFolderGroups(organization: SidebarOrganization): SidebarLibraryFolderGroup[] {
    const folders = organization.folders;
    const groups: SidebarLibraryFolderGroup[] = folders.map((folder) => ({
        folderId: folder.id,
        name: folder.name,
        lists: organization.lists.filter((list) => list.folderId === folder.id),
    }));
    const looseLists = organization.lists.filter((list) => !list.folderId || !folders.some((folder) => folder.id === list.folderId));
    if (looseLists.length > 0 || groups.length === 0) {
        groups.push({ folderId: null, name: null, lists: looseLists });
    }
    return groups;
}

export function getSidebarLibrarySessions({
    organization,
    pinnedOrder,
    projects,
    selection,
    sessions,
}: {
    organization: SidebarOrganization;
    pinnedOrder: string[];
    projects: SidebarLibraryProject[];
    selection: SidebarLibrarySelection;
    sessions: SessionRowData[];
}): SessionRowData[] {
    const partitioned = partitionSessionsByPinnedOrder(sessions, pinnedOrder);
    if (selection.kind === 'pinned') return partitioned.pinned;
    if (selection.kind === 'timeline') return partitioned.regular;
    if (selection.kind === 'project') {
        return projects.find((project) => project.key === selection.key)?.sessions ?? [];
    }
    if (selection.kind === 'list') {
        return partitioned.regular.filter((session) => organization.sessions[session.id]?.listId === selection.id);
    }
    if (selection.kind === 'tag') {
        return partitioned.regular.filter((session) => organization.sessions[session.id]?.tagIds.includes(selection.id));
    }
    return partitioned.regular.filter((session) => !organization.sessions[session.id]?.listId);
}

export function isSidebarLibrarySelectionEqual(
    left: SidebarLibrarySelection,
    right: SidebarLibrarySelection,
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'project' && right.kind === 'project') return left.key === right.key;
    if (left.kind === 'list' && right.kind === 'list') return left.id === right.id;
    if (left.kind === 'tag' && right.kind === 'tag') return left.id === right.id;
    return true;
}
