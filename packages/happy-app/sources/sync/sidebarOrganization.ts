import type { NewSessionAgentType } from '@/sync/persistence';
import * as z from 'zod';
import equal from 'fast-deep-equal';

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

const SidebarListColorSchema = z.enum(SIDEBAR_LIST_COLORS);
const SidebarWorkspaceListSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(SIDEBAR_LIST_NAME_MAX_LENGTH),
    kind: z.literal('workspace'),
    color: SidebarListColorSchema,
    machineId: z.string().max(200).nullable(),
    path: z.string().max(SIDEBAR_LIST_PATH_MAX_LENGTH).nullable(),
    defaultAgent: z.enum(['ask', 'claude', 'codex', 'gemini', 'opencode', 'openclaw']).nullable(),
    createdAt: z.number().finite(),
}).passthrough();
const SidebarAgentListSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(SIDEBAR_LIST_NAME_MAX_LENGTH),
    kind: z.literal('agent'),
    color: SidebarListColorSchema,
    createdAt: z.number().finite(),
}).passthrough();
const SidebarListSchema = z.discriminatedUnion('kind', [SidebarWorkspaceListSchema, SidebarAgentListSchema]);

const SidebarTagSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(SIDEBAR_LIST_NAME_MAX_LENGTH),
    color: SidebarListColorSchema,
    createdAt: z.number().finite(),
}).passthrough();

const SidebarSessionOrganizationSchema = z.object({
    listId: z.string().nullable(),
    tagIds: z.array(z.string()),
}).passthrough();

const StrictSidebarOrganizationSchema = z.object({
    lists: z.array(SidebarListSchema),
    tags: z.array(SidebarTagSchema),
    sessions: z.record(z.string(), SidebarSessionOrganizationSchema),
}).passthrough();

export const SidebarOrganizationSchema = z.object({
    lists: z.array(z.unknown()).transform((items): SidebarList[] => {
        const lists: SidebarList[] = [];
        for (const item of items) {
            const parsed = SidebarListSchema.safeParse(item);
            if (!parsed.success) continue;
            if (parsed.data.kind !== 'agent') {
                lists.push(parsed.data);
                continue;
            }

            // These keys belonged to the removed Agent List launch-preset format. Keep
            // genuinely unknown future keys, but do not revive known legacy behavior.
            const {
                machineId: _machineId,
                path: _path,
                prompt: _prompt,
                presets: _presets,
                ...agentList
            } = parsed.data;
            lists.push(agentList);
        }
        return lists;
    }),
    tags: z.array(z.unknown()).transform((items) => items.flatMap((item) => {
        const parsed = SidebarTagSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    })),
    sessions: z.record(z.string(), z.unknown()).transform((sessions) => Object.fromEntries(
        Object.entries(sessions).flatMap(([sessionId, assignment]) => {
            const parsed = SidebarSessionOrganizationSchema.safeParse(assignment);
            return parsed.success ? [[sessionId, parsed.data]] : [];
        }),
    )),
}).passthrough().catch(emptySidebarOrganization);

export function isValidSidebarOrganizationPayload(value: unknown): boolean {
    return StrictSidebarOrganizationSchema.safeParse(value).success;
}

export function isUsableSidebarOrganizationPayload(value: unknown): value is {
    lists: unknown[];
    tags: unknown[];
    sessions: Record<string, unknown>;
} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as { lists?: unknown; tags?: unknown; sessions?: unknown };
    return Array.isArray(candidate.lists)
        && Array.isArray(candidate.tags)
        && !!candidate.sessions
        && typeof candidate.sessions === 'object'
        && !Array.isArray(candidate.sessions);
}

export function serializeSidebarOrganizationWithRaw(
    organization: SidebarOrganization,
    rawValue: unknown,
): unknown {
    if (!isUsableSidebarOrganizationPayload(rawValue)) return organization;

    const unknownLists = rawValue.lists.filter((item) => (
        !SidebarListSchema.safeParse(item).success
    ));
    const unknownTags = rawValue.tags.filter((item) => !SidebarTagSchema.safeParse(item).success);
    const unknownSessions = Object.fromEntries(Object.entries(rawValue.sessions).filter(([, assignment]) => (
        !SidebarSessionOrganizationSchema.safeParse(assignment).success
    )));

    return {
        ...rawValue,
        lists: [...organization.lists, ...unknownLists],
        tags: [...organization.tags, ...unknownTags],
        sessions: { ...unknownSessions, ...organization.sessions },
    };
}

export function isSidebarOrganizationEmpty(value: SidebarOrganization): boolean {
    return value.lists.length === 0
        && value.tags.length === 0
        && Object.keys(value.sessions).length === 0;
}

function mergeValue<T>(base: T, local: T, remote: T): T {
    if (equal(local, base)) return remote;
    if (equal(remote, base)) return local;
    return local;
}

function mergeEntity<T extends { id: string }>(base: T | undefined, local: T | undefined, remote: T | undefined): T | undefined {
    if (equal(local, base)) return remote;
    if (equal(remote, base)) return local;
    if (!local || !remote) return local;
    if (!base) return local;

    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(remote), ...Object.keys(local)])) {
        merged[key] = mergeValue(
            (base as Record<string, unknown>)[key],
            (local as Record<string, unknown>)[key],
            (remote as Record<string, unknown>)[key],
        );
    }
    return merged as T;
}

function mergeEntityList<T extends { id: string }>(base: readonly T[], local: readonly T[], remote: readonly T[]): T[] {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const localById = new Map(local.map((item) => [item.id, item]));
    const remoteById = new Map(remote.map((item) => [item.id, item]));
    const mergedById = new Map<string, T>();

    for (const id of new Set([...baseById.keys(), ...remoteById.keys(), ...localById.keys()])) {
        const merged = mergeEntity(baseById.get(id), localById.get(id), remoteById.get(id));
        if (merged) mergedById.set(id, merged);
    }

    const baseOrder = base.map((item) => item.id);
    const localOrder = local.map((item) => item.id);
    const remoteOrder = remote.map((item) => item.id);
    const preferredOrder = equal(localOrder, baseOrder) ? remoteOrder : localOrder;
    return [...preferredOrder, ...remoteOrder, ...localOrder]
        .filter((id, index, ids) => ids.indexOf(id) === index)
        .flatMap((id) => {
            const item = mergedById.get(id);
            return item ? [item] : [];
        });
}

function mergeTagIds(base: readonly string[], local: readonly string[], remote: readonly string[]): string[] {
    const baseIds = new Set(base);
    const localIds = new Set(local);
    const remoteIds = new Set(remote);
    const removed = new Set([...baseIds].filter((id) => !localIds.has(id) || !remoteIds.has(id)));
    return [...remote, ...local].filter((id, index, ids) => !removed.has(id) && ids.indexOf(id) === index);
}

function mergeSessionAssignment(
    base: SidebarSessionOrganization | undefined,
    local: SidebarSessionOrganization | undefined,
    remote: SidebarSessionOrganization | undefined,
): SidebarSessionOrganization | undefined {
    if (equal(local, base)) return remote;
    if (equal(remote, base)) return local;
    if (!local || !remote) return local;
    if (!base) {
        return {
            listId: mergeValue(null, local.listId, remote.listId),
            tagIds: mergeTagIds([], local.tagIds, remote.tagIds),
        };
    }
    return {
        listId: mergeValue(base.listId, local.listId, remote.listId),
        tagIds: mergeTagIds(base.tagIds, local.tagIds, remote.tagIds),
    };
}

export function mergeSidebarOrganizations(
    base: SidebarOrganization,
    local: SidebarOrganization,
    remote: SidebarOrganization,
): SidebarOrganization {
    const sessions: SidebarOrganization['sessions'] = {};
    for (const sessionId of new Set([
        ...Object.keys(base.sessions),
        ...Object.keys(remote.sessions),
        ...Object.keys(local.sessions),
    ])) {
        const merged = mergeSessionAssignment(base.sessions[sessionId], local.sessions[sessionId], remote.sessions[sessionId]);
        if (merged) sessions[sessionId] = merged;
    }

    return normalizeSidebarOrganization({
        lists: mergeEntityList(base.lists, local.lists, remote.lists),
        tags: mergeEntityList(base.tags, local.tags, remote.tags),
        sessions,
    });
}

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

export function normalizeSidebarTagName(value: string): string {
    return value.trim().replace(/^#+\s*/, '').trim().slice(0, SIDEBAR_LIST_NAME_MAX_LENGTH);
}

export function normalizeSidebarOrganization(value: SidebarOrganization): SidebarOrganization {
    const listIds = new Set(value.lists.map((list) => list.id));
    const tagIds = new Set(value.tags.map((tag) => tag.id));
    const sessions = Object.fromEntries(Object.entries(value.sessions).map(([sessionId, assignment]) => [
        sessionId,
        {
            listId: assignment.listId && listIds.has(assignment.listId) ? assignment.listId : null,
            tagIds: Array.from(new Set(assignment.tagIds.filter((tagId) => tagIds.has(tagId)))),
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

export function moveSidebarSessionToList(
    value: SidebarOrganization,
    sessionId: string,
    listId: string | null,
): SidebarOrganization {
    const assignment = value.sessions[sessionId] ?? { listId: null, tagIds: [] };
    if (assignment.listId === listId) return value;
    return organizeSession(value, sessionId, { ...assignment, listId });
}

export function reorderSidebarList(
    value: SidebarOrganization,
    sourceListId: string,
    targetListId: string,
    position: 'before' | 'after',
): SidebarOrganization {
    if (sourceListId === targetListId) return value;
    const source = value.lists.find((list) => list.id === sourceListId);
    if (!source || !value.lists.some((list) => list.id === targetListId)) return value;

    const lists = value.lists.filter((list) => list.id !== sourceListId);
    const targetIndex = lists.findIndex((list) => list.id === targetListId);
    lists.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source);
    if (lists.every((list, index) => list === value.lists[index])) return value;
    return { ...value, lists };
}

export function organizeSessionWithCreatedTags(
    value: SidebarOrganization,
    sessionId: string,
    assignment: SidebarSessionOrganization,
    createdTags: readonly SidebarTag[],
): SidebarOrganization {
    const tags = [...value.tags];
    const remappedTagIds = new Map<string, string>();

    for (const draftTag of createdTags) {
        if (!assignment.tagIds.includes(draftTag.id)) continue;
        const name = normalizeSidebarTagName(draftTag.name);
        if (!name) continue;

        const existing = tags.find((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (existing) {
            remappedTagIds.set(draftTag.id, existing.id);
            continue;
        }
        if (tags.length >= SIDEBAR_TAG_MAX_COUNT) continue;

        tags.push({ ...draftTag, name });
        remappedTagIds.set(draftTag.id, draftTag.id);
    }

    return organizeSession({ ...value, tags }, sessionId, {
        ...assignment,
        tagIds: assignment.tagIds.map((tagId) => remappedTagIds.get(tagId) ?? tagId),
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
