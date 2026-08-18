import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

const mocks = vi.hoisted(() => ({
    data: null as SessionListViewItem[] | null,
    hideInactiveSessions: false,
}));

// The hooks only ever read `React.useMemo` / `React.useCallback`, and
// storage.ts pulls in React Native, so both are stubbed down to the surface
// the hooks actually touch.
vi.mock('react', () => ({
    useMemo: <T,>(factory: () => T) => factory(),
    useCallback: <T,>(callback: T) => callback,
}));

vi.mock('@/sync/storage', () => ({
    useSessionListViewData: () => mocks.data,
    useSetting: (key: string) => {
        if (key !== 'hideInactiveSessions') {
            throw new Error(`Unexpected setting read: ${key}`);
        }
        return mocks.hideInactiveSessions;
    },
}));

import {
    useArchivedSessionListViewData,
    useVisibleSessionListViewData,
} from './useVisibleSessionListViewData';

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
    mocks.hideInactiveSessions = false;
});

describe('useVisibleSessionListViewData', () => {
    // A project card and a flat row, each holding one finished-but-listed
    // session and one the user archived.
    function mixedList(): SessionListViewItem[] {
        return [
            project('p1', [row('project-finished'), row('project-archived', { archived: true })]),
            { type: 'section', title: 'Today' },
            { type: 'session', session: row('flat-finished') },
            { type: 'session', session: row('flat-archived', { archived: true }) },
        ];
    }

    it('passes through a list that has not loaded yet', () => {
        mocks.data = null;

        expect(useVisibleSessionListViewData()).toBeNull();
    });

    it('keeps a finished session in both list shapes and hides the archived one', () => {
        mocks.data = mixedList();

        const result = useVisibleSessionListViewData()!;

        expect(projectSessionIds(result)).toEqual(['project-finished']);
        expect(flatSessionIds(result)).toEqual(['flat-finished']);
    });

    // The two axes are independent: archiving is the user's call, and a session
    // whose agent merely exited was never archived by anyone.
    it('still hides an archived session when finished sessions are shown', () => {
        mocks.data = mixedList();
        mocks.hideInactiveSessions = false;

        const result = useVisibleSessionListViewData()!;

        expect(projectSessionIds(result)).not.toContain('project-archived');
        expect(flatSessionIds(result)).not.toContain('flat-archived');
    });

    it('hides finished sessions too once the setting is on', () => {
        mocks.data = [
            project('p1', [row('live', { active: true }), row('finished')]),
            { type: 'session', session: row('flat-live', { active: true }) },
            { type: 'session', session: row('flat-finished') },
        ];
        mocks.hideInactiveSessions = true;

        const result = useVisibleSessionListViewData()!;

        expect(projectSessionIds(result)).toEqual(['live']);
        expect(flatSessionIds(result)).toEqual(['flat-live']);
    });

    it('refreshes the project badge to match the rows left', () => {
        mocks.data = [project('p1', [
            row('live', { active: true }),
            row('finished'),
            row('archived', { archived: true }),
        ])];

        const [item] = useVisibleSessionListViewData()!;

        expect(item.type === 'project' && item.project).toMatchObject({
            sessionCount: 2,
            activeCount: 1,
        });
    });

    it('drops a date header once everything under it is filtered out', () => {
        mocks.data = [
            { type: 'section', title: 'Today' },
            { type: 'session', session: row('archived', { archived: true }) },
            { type: 'section', title: 'Yesterday' },
            { type: 'session', session: row('finished') },
        ];

        const result = useVisibleSessionListViewData()!;

        expect(result.map((item) => (item.type === 'section' ? item.title : item.type)))
            .toEqual(['Yesterday', 'session']);
    });

    it('drops a project once every session under it is archived', () => {
        mocks.data = [project('p1', [row('archived', { archived: true })])];

        expect(useVisibleSessionListViewData()).toEqual([]);
    });

    it('keeps the active-sessions group regardless of the setting', () => {
        mocks.data = [{ type: 'active-sessions', sessions: [row('live', { active: true })] }];
        mocks.hideInactiveSessions = true;

        expect(useVisibleSessionListViewData()).toEqual(mocks.data);
    });
});

describe('useArchivedSessionListViewData', () => {
    it('shows only archived sessions, in both list shapes', () => {
        mocks.data = [
            project('p1', [row('finished'), row('project-archived', { archived: true })]),
            { type: 'section', title: 'Today' },
            { type: 'session', session: row('flat-finished') },
            { type: 'session', session: row('flat-archived', { archived: true }) },
        ];

        const result = useArchivedSessionListViewData()!;

        expect(projectSessionIds(result)).toEqual(['project-archived']);
        expect(flatSessionIds(result)).toEqual(['flat-archived']);
    });

    // The archive is not a live-session view: whether the agent is running says
    // nothing about whether the user filed the session away.
    it('keeps an archived session that is somehow still running', () => {
        mocks.data = [{ type: 'session', session: row('archived-live', { active: true, archived: true }) }];
        mocks.hideInactiveSessions = true;

        expect(flatSessionIds(useArchivedSessionListViewData()!)).toEqual(['archived-live']);
    });

    it('is empty when nothing is archived', () => {
        mocks.data = [project('p1', [row('finished')]), { type: 'session', session: row('flat-finished') }];

        expect(useArchivedSessionListViewData()).toEqual([]);
    });
});
