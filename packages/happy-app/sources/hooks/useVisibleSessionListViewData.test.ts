import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

const mocks = vi.hoisted(() => ({
    data: null as SessionListViewItem[] | null,
    hideArchivedSessions: false,
}));

// The hook only ever reads `React.useMemo`, and storage.ts pulls in React
// Native, so both are stubbed down to the surface the hook actually touches.
vi.mock('react', () => ({
    useMemo: <T,>(factory: () => T) => factory(),
}));

vi.mock('@/sync/storage', () => ({
    useSessionListViewData: () => mocks.data,
    useSetting: (key: string) => {
        if (key !== 'hideInactiveSessions') {
            throw new Error(`Unexpected setting read: ${key}`);
        }
        return mocks.hideArchivedSessions;
    },
}));

import { useVisibleSessionListViewData } from './useVisibleSessionListViewData';

// Only the fields the visibility filter reads; the real rows are built in
// storage.ts.
function row(id: string, options: { active?: boolean; archived?: boolean } = {}): SessionRowData {
    return {
        id,
        name: id,
        active: options.active ?? false,
        archived: options.archived ?? false,
    } as SessionRowData;
}

function project(id: string, sessions: SessionRowData[]): SessionListViewItem {
    return {
        type: 'project',
        source: 'rig',
        project: {
            id,
            name: id,
            machineId: 'machine-1',
            sessionCount: sessions.length,
            activeCount: sessions.filter((session) => session.active).length,
            workspaces: [{ id: '', name: null, sessions }],
        },
    };
}

function projectSessionIds(items: SessionListViewItem[]): string[] {
    return items.flatMap((item) => (item.type === 'project'
        ? item.project.workspaces.flatMap((workspace) => workspace.sessions.map((s) => s.id))
        : []));
}

function flatSessionIds(items: SessionListViewItem[]): string[] {
    return items.flatMap((item) => (item.type === 'session' ? [item.session.id] : []));
}

beforeEach(() => {
    mocks.data = null;
    mocks.hideArchivedSessions = false;
});

describe('useVisibleSessionListViewData', () => {
    // A project card and a flat row, each holding one merely-disconnected
    // session and one archived one.
    function mixedList(): SessionListViewItem[] {
        return [
            { type: 'projects-header', source: 'rig' },
            project('p1', [row('project-disconnected'), row('project-archived', { archived: true })]),
            { type: 'header', title: 'Today' },
            { type: 'session', session: row('flat-disconnected') },
            { type: 'session', session: row('flat-archived', { archived: true }) },
        ];
    }

    it('passes through a list that has not loaded yet', () => {
        mocks.data = null;

        expect(useVisibleSessionListViewData()).toBeNull();
    });

    it('keeps a disconnected-but-unarchived session in both list shapes while hiding the archive', () => {
        mocks.data = mixedList();
        mocks.hideArchivedSessions = true;

        const result = useVisibleSessionListViewData()!;

        expect(projectSessionIds(result)).toEqual(['project-disconnected']);
        expect(flatSessionIds(result)).toEqual(['flat-disconnected']);
    });

    it('hides an archived session in both list shapes', () => {
        mocks.data = mixedList();
        mocks.hideArchivedSessions = true;

        const result = useVisibleSessionListViewData()!;

        expect(projectSessionIds(result)).not.toContain('project-archived');
        expect(flatSessionIds(result)).not.toContain('flat-archived');
    });

    it('refreshes the project badge to match the rows left', () => {
        mocks.data = [project('p1', [
            row('live', { active: true }),
            row('disconnected'),
            row('archived', { archived: true }),
        ])];
        mocks.hideArchivedSessions = true;

        const [item] = useVisibleSessionListViewData()!;

        expect(item.type === 'project' && item.project).toMatchObject({
            sessionCount: 2,
            activeCount: 1,
        });
    });

    it('shows every session in both list shapes when the archive is revealed', () => {
        mocks.data = mixedList();
        mocks.hideArchivedSessions = false;

        const result = useVisibleSessionListViewData()!;

        expect(projectSessionIds(result)).toEqual(['project-disconnected', 'project-archived']);
        expect(flatSessionIds(result)).toEqual(['flat-disconnected', 'flat-archived']);
    });

    it('drops a date header once everything under it is archived', () => {
        mocks.data = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: row('archived', { archived: true }) },
            { type: 'header', title: 'Yesterday' },
            { type: 'session', session: row('disconnected') },
        ];
        mocks.hideArchivedSessions = true;

        const result = useVisibleSessionListViewData()!;

        expect(result.map((item) => (item.type === 'header' ? item.title : item.type)))
            .toEqual(['Yesterday', 'session']);
    });

    it('drops a projects header once every project under it is archived', () => {
        mocks.data = [
            { type: 'projects-header', source: 'rig' },
            project('p1', [row('archived', { archived: true })]),
        ];
        mocks.hideArchivedSessions = true;

        expect(useVisibleSessionListViewData()).toEqual([]);
    });

    it('keeps the active-sessions group regardless of the toggle', () => {
        mocks.data = [{ type: 'active-sessions', sessions: [row('live', { active: true })] }];
        mocks.hideArchivedSessions = true;

        expect(useVisibleSessionListViewData()).toEqual(mocks.data);
    });
});
