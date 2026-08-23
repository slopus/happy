import { describe, expect, it } from 'vitest';
import {
    buildSidebarSessionIndex,
    normalizeSidebarOrganization,
    organizeSession,
    removeSidebarList,
    removeSidebarTag,
    type SidebarOrganization,
} from './sidebarOrganization';

const organization: SidebarOrganization = {
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
});
