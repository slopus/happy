import { describe, expect, it } from 'vitest';
import {
    buildSidebarSessionIndex,
    mergeSidebarOrganizations,
    moveSidebarSessionToList,
    normalizeSidebarTagName,
    normalizeSidebarOrganization,
    organizeSession,
    organizeSessionWithCreatedTags,
    reorderSidebarList,
    removeSidebarFolder,
    removeSidebarList,
    removeSidebarTag,
    type SidebarOrganization,
} from './sidebarOrganization';

const organization: SidebarOrganization = {
    folders: [],
    lists: [
        { id: 'workspace', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'mac', path: '~/happy', defaultAgent: 'codex', createdAt: 1 },
        { id: 'advisor', name: 'Advisor', kind: 'agent', color: 'pink', createdAt: 2 },
    ],
    tags: [
        { id: 'product', name: 'product', color: 'green', createdAt: 1 },
        { id: 'research', name: 'research', color: 'purple', createdAt: 2 },
    ],
    sessions: {},
};

describe('sidebar organization model', () => {
    it('normalizes a typed hashtag without storing the hash marker', () => {
        expect(normalizeSidebarTagName('  ##  Product  ')).toBe('Product');
        expect(normalizeSidebarTagName('#')).toBe('');
    });

    it('keeps one list and multiple unique tags per session', () => {
        const next = organizeSession(organization, 'session-1', {
            listId: 'workspace',
            tagIds: ['product', 'research', 'product'],
        });

        expect(next.sessions['session-1']).toEqual({
            listId: 'workspace',
            tagIds: ['product', 'research'],
        });
    });

    it('moves a session between Lists without changing its Tags', () => {
        const assigned = organizeSession(organization, 'session-1', {
            listId: 'workspace',
            tagIds: ['product', 'research'],
        });

        expect(moveSidebarSessionToList(assigned, 'session-1', 'advisor').sessions['session-1']).toEqual({
            listId: 'advisor',
            tagIds: ['product', 'research'],
        });
    });

    it('moves a session back to Unassigned without changing its Tags', () => {
        const assigned = organizeSession(organization, 'session-1', {
            listId: 'workspace',
            tagIds: ['product'],
        });

        expect(moveSidebarSessionToList(assigned, 'session-1', null).sessions['session-1']).toEqual({
            listId: null,
            tagIds: ['product'],
        });
    });

    it('reorders Lists before or after a drop target without changing assignments', () => {
        const assigned = organizeSession(organization, 'session-1', {
            listId: 'workspace',
            tagIds: ['product'],
        });

        const movedBefore = reorderSidebarList(assigned, 'advisor', 'workspace', 'before');
        expect(movedBefore.lists.map((list) => list.id)).toEqual(['advisor', 'workspace']);
        expect(movedBefore.sessions['session-1']).toEqual({ listId: 'workspace', tagIds: ['product'] });

        const movedAfter = reorderSidebarList(movedBefore, 'advisor', 'workspace', 'after');
        expect(movedAfter.lists.map((list) => list.id)).toEqual(['workspace', 'advisor']);
        expect(movedAfter.sessions['session-1']).toEqual({ listId: 'workspace', tagIds: ['product'] });
    });

    it('creates and assigns draft Tags atomically while reusing case-insensitive matches', () => {
        const next = organizeSessionWithCreatedTags({
            folders: [],
            lists: [],
            tags: [{ id: 'existing', name: 'product', color: 'green', createdAt: 1 }],
            sessions: {},
        }, 'session-1', {
            listId: null,
            tagIds: ['draft-existing', 'draft-new'],
        }, [
            { id: 'draft-existing', name: '#Product', color: 'blue', createdAt: 2 },
            { id: 'draft-new', name: '#research', color: 'purple', createdAt: 3 },
            { id: 'draft-unused', name: '#unused', color: 'orange', createdAt: 4 },
        ]);

        expect(next.tags).toEqual([
            { id: 'existing', name: 'product', color: 'green', createdAt: 1 },
            { id: 'draft-new', name: 'research', color: 'purple', createdAt: 3 },
        ]);
        expect(next.sessions['session-1']).toEqual({ listId: null, tagIds: ['existing', 'draft-new'] });
    });

    it('clears deleted list and tag references without removing the session', () => {
        const assigned = organizeSession(organization, 'session-1', {
            listId: 'workspace',
            tagIds: ['product', 'research'],
        });

        expect(removeSidebarTag(removeSidebarList(assigned, 'workspace'), 'product').sessions['session-1']).toEqual({
            listId: null,
            tagIds: ['research'],
        });
    });

    it('drops references to records that do not exist', () => {
        expect(normalizeSidebarOrganization({
            ...organization,
            sessions: { broken: { listId: 'missing', tagIds: ['missing'] } },
        }).sessions.broken).toEqual({ listId: null, tagIds: [] });
    });

    it('keeps folder membership valid and releases Lists when a folder is deleted', () => {
        const withFolder: SidebarOrganization = normalizeSidebarOrganization({
            ...organization,
            folders: [{ id: 'folder-work', name: 'Work', createdAt: 1 }],
            lists: organization.lists.map((list) => ({ ...list, folderId: 'folder-work' })),
        });

        expect(withFolder.lists.map((list) => list.folderId)).toEqual(['folder-work', 'folder-work']);
        const released = removeSidebarFolder(withFolder, 'folder-work');
        expect(released.folders).toEqual([]);
        expect(released.lists.map((list) => list.folderId)).toEqual([null, null]);
    });

    it('indexes a large session set in one pass for Lists and Tags', () => {
        const sessions = Array.from({ length: 100 }, (_, index) => ({ id: `session-${index}` }));
        const assignments = Object.fromEntries(sessions.map((session, index) => [
            session.id,
            {
                listId: index < 40 ? 'workspace' : index < 70 ? 'advisor' : null,
                tagIds: index % 2 === 0 ? ['product'] : ['research'],
            },
        ]));

        const index = buildSidebarSessionIndex(sessions, assignments);

        expect(index.byListId.get('workspace')).toHaveLength(40);
        expect(index.byListId.get('advisor')).toHaveLength(30);
        expect(index.unassigned).toHaveLength(30);
        expect(index.byTagId.get('product')).toHaveLength(50);
        expect(index.byTagId.get('research')).toHaveLength(50);
    });

    it('three-way merges concurrent additions from different clients without losing data', () => {
        const base = organizeSession(organization, 'session-1', { listId: null, tagIds: [] });
        const local = organizeSession({
            ...base,
            tags: [...base.tags, { id: 'local', name: 'local', color: 'blue', createdAt: 3 }],
        }, 'session-1', { listId: null, tagIds: ['local'] });
        const remote = organizeSession({
            ...base,
            tags: [...base.tags, { id: 'remote', name: 'remote', color: 'orange', createdAt: 4 }],
        }, 'session-1', { listId: 'workspace', tagIds: ['remote'] });

        const merged = mergeSidebarOrganizations(base, local, remote);

        expect(merged.tags.map((tag) => tag.id)).toEqual(['product', 'research', 'local', 'remote']);
        expect(merged.sessions['session-1']).toEqual({
            listId: 'workspace',
            tagIds: ['remote', 'local'],
        });
    });

    it('preserves intentional deletions while merging unrelated remote additions', () => {
        const base = organizeSession(organization, 'session-1', {
            listId: 'workspace',
            tagIds: ['product'],
        });
        const local = removeSidebarTag(base, 'product');
        const remote = {
            ...base,
            tags: [...base.tags, { id: 'remote', name: 'remote', color: 'orange' as const, createdAt: 4 }],
        };

        const merged = mergeSidebarOrganizations(base, local, remote);

        expect(merged.tags.map((tag) => tag.id)).toEqual(['research', 'remote']);
        expect(merged.sessions['session-1']?.tagIds).toEqual([]);
    });

    it('keeps concurrent additions above UI creation limits parseable and lossless', () => {
        const baseTags = Array.from({ length: 499 }, (_, index) => ({
            id: `tag-${index}`,
            name: `tag-${index}`,
            color: 'blue' as const,
            createdAt: index,
        }));
        const base: SidebarOrganization = {
            folders: [],
            lists: Array.from({ length: 199 }, (_, index) => ({
                id: `list-${index}`,
                name: `List ${index}`,
                kind: 'agent' as const,
                color: 'blue' as const,
                createdAt: index,
            })),
            tags: baseTags,
            sessions: { 'session-1': { listId: null, tagIds: baseTags.slice(0, 99).map((tag) => tag.id) } },
        };
        const local: SidebarOrganization = {
            folders: [],
            lists: [...base.lists, { id: 'list-local', name: 'Local', kind: 'agent', color: 'green', createdAt: 200 }],
            tags: [...base.tags, { id: 'tag-local', name: 'local', color: 'green', createdAt: 100 }],
            sessions: { 'session-1': { listId: null, tagIds: [...base.sessions['session-1'].tagIds, 'tag-local'] } },
        };
        const remote: SidebarOrganization = {
            folders: [],
            lists: [...base.lists, { id: 'list-remote', name: 'Remote', kind: 'agent', color: 'pink', createdAt: 201 }],
            tags: [...base.tags, { id: 'tag-remote', name: 'remote', color: 'pink', createdAt: 101 }],
            sessions: { 'session-1': { listId: null, tagIds: [...base.sessions['session-1'].tagIds, 'tag-remote'] } },
        };

        const merged = mergeSidebarOrganizations(base, local, remote);

        expect(merged.lists).toHaveLength(201);
        expect(merged.tags).toHaveLength(501);
        expect(merged.sessions['session-1'].tagIds).toHaveLength(101);
        expect(merged.sessions['session-1'].tagIds).toContain('tag-local');
        expect(merged.sessions['session-1'].tagIds).toContain('tag-remote');
    });
});
