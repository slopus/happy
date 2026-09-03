import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { SessionRowData } from '@/sync/storage';
import {
    buildSidebarLibraryFolderGroups,
    buildSidebarLibraryProjects,
    collectSidebarSessions,
    getSidebarLibrarySessions,
} from './sidebarLibraryNavigation';

vi.mock('@/utils/sessionUtils', () => ({
    formatPathRelativeToHome: (path: string, homeDir: string) => path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path,
}));

function session(id: string, path: string): SessionRowData {
    return {
        active: false,
        archived: false,
        avatarId: 'avatar',
        completedTodosCount: 0,
        flavor: 'codex',
        hasDraft: false,
        hasUnread: false,
        homeDir: '/workspace',
        id,
        isConnected: false,
        machineId: 'machine',
        name: id,
        path,
        state: 'idle',
        subtitle: id,
        totalTodosCount: 0,
    };
}

const organization = {
    folders: [{ id: 'work', name: 'Work', createdAt: 1 }],
    lists: [
        { id: 'alpha', name: 'Alpha', kind: 'workspace' as const, color: 'blue' as const, folderId: 'work', machineId: null, path: null, defaultAgent: null, createdAt: 1 },
        { id: 'loose', name: 'Loose', kind: 'agent' as const, color: 'pink' as const, folderId: null, createdAt: 2 },
    ],
    tags: [{ id: 'review', name: 'Review', color: 'green' as const, createdAt: 1 }],
    sessions: {
        one: { listId: 'alpha', tagIds: ['review'] },
        two: { listId: null, tagIds: [] },
    },
};

describe('sidebar library navigation', () => {
    it('collects each visible session once', () => {
        const one = session('one', '/workspace/alpha');
        const two = session('two', '/workspace/beta');
        expect(collectSidebarSessions([
            { type: 'active-sessions', sessions: [one, two] },
            { type: 'session', session: one },
        ])).toEqual([one, two]);
    });

    it('flattens machine projects for the organization column and excludes pinned sessions', () => {
        const projects = buildSidebarLibraryProjects({
            machines: [],
            pinnedOrder: ['two'],
            sessions: [session('one', '/workspace/alpha'), session('two', '/workspace/beta')],
            unknownLabel: 'Unknown',
        });
        expect(projects.map((project) => project.displayPath)).toEqual(['~/alpha']);
    });

    it('keeps folders expandable while preserving loose historical lists', () => {
        const groups = buildSidebarLibraryFolderGroups(organization);
        expect(groups).toEqual([
            expect.objectContaining({ folderId: 'work', name: 'Work', lists: [expect.objectContaining({ id: 'alpha' })] }),
            expect.objectContaining({ folderId: null, lists: [expect.objectContaining({ id: 'loose' })] }),
        ]);
    });

    it('filters the middle column without duplicating pinned sessions', () => {
        const sessions = [session('one', '/workspace/alpha'), session('two', '/workspace/beta')];
        const projects = buildSidebarLibraryProjects({ machines: [], pinnedOrder: ['two'], sessions, unknownLabel: 'Unknown' });
        expect(getSidebarLibrarySessions({ organization, pinnedOrder: ['two'], projects, selection: { kind: 'list', id: 'alpha' }, sessions }).map((item) => item.id)).toEqual(['one']);
        expect(getSidebarLibrarySessions({ organization, pinnedOrder: ['two'], projects, selection: { kind: 'unassigned' }, sessions })).toEqual([]);
        expect(getSidebarLibrarySessions({ organization, pinnedOrder: ['two'], projects, selection: { kind: 'pinned' }, sessions }).map((item) => item.id)).toEqual(['two']);
    });
});
