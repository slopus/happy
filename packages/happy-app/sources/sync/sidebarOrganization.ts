import type { NewSessionAgentType } from '@/sync/persistence';

export const SIDEBAR_LIST_COLORS = ['blue', 'green', 'purple', 'orange', 'pink'] as const;
export const SIDEBAR_LIST_NAME_MAX_LENGTH = 80;
export const SIDEBAR_LIST_PATH_MAX_LENGTH = 2_000;
export const SIDEBAR_LIST_MAX_COUNT = 200;
export const SIDEBAR_TAG_MAX_COUNT = 500;
export const SIDEBAR_SESSION_TAG_MAX_COUNT = 100;

export type SidebarListColor = typeof SIDEBAR_LIST_COLORS[number];

export type SidebarWorkspaceList = {
    id: string;
    name: string;
    kind: 'workspace';
    color: SidebarListColor;
    machineId: string | null;
    path: string | null;
    defaultAgent: NewSessionAgentType | null;
    createdAt: number;
};

export type SidebarAgentList = {
    id: string;
    name: string;
    kind: 'agent';
    color: SidebarListColor;
    createdAt: number;
};

export type SidebarList = SidebarWorkspaceList | SidebarAgentList;

export type SidebarTag = {
    id: string;
    name: string;
    color: SidebarListColor;
    createdAt: number;
};

export type SidebarSessionOrganization = {
    listId: string | null;
    tagIds: string[];
};

export type SidebarOrganization = {
    lists: SidebarList[];
    tags: SidebarTag[];
    sessions: Record<string, SidebarSessionOrganization>;
};

export const emptySidebarOrganization: SidebarOrganization = {
    lists: [],
    tags: [],
    sessions: {},
};

export type SidebarSessionIndex<T extends { id: string }> = {
    byListId: Map<string, T[]>;
    byTagId: Map<string, T[]>;
    unassigned: T[];
};

export function buildSidebarSessionIndex<T extends { id: string }>(
    sessions: readonly T[],
    assignments: SidebarOrganization['sessions'],
): SidebarSessionIndex<T> {
    const byListId = new Map<string, T[]>();
    const byTagId = new Map<string, T[]>();
    const unassigned: T[] = [];

    for (const session of sessions) {
        const assignment = assignments[session.id];
        if (assignment?.listId) {
            const listSessions = byListId.get(assignment.listId);
            if (listSessions) listSessions.push(session);
            else byListId.set(assignment.listId, [session]);
        } else {
            unassigned.push(session);
        }

        for (const tagId of assignment?.tagIds ?? []) {
            const tagSessions = byTagId.get(tagId);
            if (tagSessions) tagSessions.push(session);
            else byTagId.set(tagId, [session]);
        }
    }

    return { byListId, byTagId, unassigned };
}

export function createSidebarOrganizationId(prefix: 'list' | 'tag'): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeSidebarOrganization(value: SidebarOrganization): SidebarOrganization {
    const listIds = new Set(value.lists.map((list) => list.id));
    const tagIds = new Set(value.tags.map((tag) => tag.id));
    const sessions = Object.fromEntries(Object.entries(value.sessions).map(([sessionId, assignment]) => [
        sessionId,
        {
            listId: assignment.listId && listIds.has(assignment.listId) ? assignment.listId : null,
            tagIds: Array.from(new Set(assignment.tagIds.filter((tagId) => tagIds.has(tagId))))
                .slice(0, SIDEBAR_SESSION_TAG_MAX_COUNT),
        },
    ]));

    return { ...value, sessions };
}

export function organizeSession(
    value: SidebarOrganization,
    sessionId: string,
    assignment: SidebarSessionOrganization,
): SidebarOrganization {
    return normalizeSidebarOrganization({
        ...value,
        sessions: {
            ...value.sessions,
            [sessionId]: assignment,
        },
    });
}

export function removeSidebarList(value: SidebarOrganization, listId: string): SidebarOrganization {
    return normalizeSidebarOrganization({
        ...value,
        lists: value.lists.filter((list) => list.id !== listId),
    });
}

export function removeSidebarTag(value: SidebarOrganization, tagId: string): SidebarOrganization {
    return normalizeSidebarOrganization({
        ...value,
        tags: value.tags.filter((tag) => tag.id !== tagId),
    });
}
