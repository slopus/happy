import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { SessionHistoryList } from './SessionHistoryList';

const mocks = vi.hoisted(() => ({
    loadNextSessionHistoryPage: vi.fn(),
    sessionRouteBecameInteractive: vi.fn(),
    navigateToSession: vi.fn(),
    pathname: '/session/older',
    platform: 'web',
    sessions: [
        { id: 'regular', updatedAt: Date.UTC(2026, 8, 5, 9), name: 'Regular session', metadata: { lifecycleState: 'running' } },
        { id: 'older', updatedAt: Date.UTC(2026, 8, 2, 9), name: 'Older session', metadata: { lifecycleState: 'archived' } },
        { id: 'newest', updatedAt: Date.UTC(2026, 8, 4, 9), name: 'Newest session', metadata: { lifecycleState: 'archiveRequested' } },
        { id: 'same-day', updatedAt: Date.UTC(2026, 8, 4, 8), name: 'Same-day session', metadata: { lifecycleState: 'archived' } },
    ] as any[],
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    return {
        FlatList: ({ data, renderItem, ...props }: any) => ReactModule.createElement(
            'FlatList',
            props,
            data.map((item: any, index: number) => ReactModule.createElement(
                ReactModule.Fragment,
                { key: `${item.type}-${item.session?.id ?? item.date}-${index}` },
                renderItem({ item, index }),
            )),
        ),
        Platform: { get OS() { return mocks.platform; } },
        Pressable: ({ children, ...props }: any) => ReactModule.createElement(
            'Pressable',
            props,
            typeof children === 'function' ? children({ pressed: false }) : children,
        ),
        View: 'View',
    };
});
vi.mock('expo-router', () => ({ usePathname: () => mocks.pathname }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({ colors: {
            divider: '#333', groupped: { background: '#111', sectionTitle: '#aaa' },
            surface: '#171717', surfacePressed: '#222', surfaceSelected: '#292929',
            text: '#fff', textSecondary: '#aaa',
        } }),
    },
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('./ActiveSessionsGroupCompact', () => ({ CompactSessionRow: 'CompactSessionRow' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/sync/storage', () => ({
    buildSessionRowData: (session: any) => ({ id: session.id, name: session.name, updatedAt: session.updatedAt }),
    storage: { getState: () => ({ sessions: Object.fromEntries(mocks.sessions.map((session) => [session.id, session])) }) },
    useAllSessions: () => mocks.sessions,
    useIsDataReady: () => true,
}));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigateToSession }));
vi.mock('@/utils/sessionUtils', () => ({
    getSessionAvatarId: (session: any) => `avatar-${session.id}`,
    getSessionName: (session: any) => session.name,
    getSessionSubtitle: (session: any) => `subtitle-${session.id}`,
}));
vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => params?.count == null ? key : `${key}:${params.count}`,
}));
vi.mock('@/components/EmptySessionsTablet', () => ({
    EmptySessionsTablet: 'EmptySessionsTablet',
    shouldShowSessionEmptyState: (count: number) => count === 0,
}));
vi.mock('@/sync/sync', () => ({
    sync: { loadNextSessionHistoryPage: mocks.loadNextSessionHistoryPage, sessionRouteBecameInteractive: mocks.sessionRouteBecameInteractive },
}));

describe('SessionHistoryList', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 8, 4, 12));
        mocks.pathname = '/session/older';
        mocks.platform = 'web';
        mocks.sessions = [
            { id: 'regular', updatedAt: Date.UTC(2026, 8, 5, 9), name: 'Regular session', metadata: { lifecycleState: 'running' } },
            { id: 'older', updatedAt: Date.UTC(2026, 8, 2, 9), name: 'Older session', metadata: { lifecycleState: 'archived' } },
            { id: 'newest', updatedAt: Date.UTC(2026, 8, 4, 9), name: 'Newest session', metadata: { lifecycleState: 'archiveRequested' } },
            { id: 'same-day', updatedAt: Date.UTC(2026, 8, 4, 8), name: 'Same-day session', metadata: { lifecycleState: 'archived' } },
        ];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        consoleErrorSpy.mockRestore();
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('renders archived conversations with the compact rows used by the main sidebar', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionHistoryList variant="sidebar" />); });

        expect(renderer.root.findAllByType('Avatar')).toHaveLength(0);
        expect(renderer.root.findAllByType('CompactSessionRow').map((node: any) => node.props.session.id)).toEqual([
            'newest',
            'same-day',
            'older',
        ]);

        act(() => renderer.unmount());
    });

    it('shows one archived logical chat based on its current execution rather than each old segment', () => {
        mocks.sessions = [
            { id: 'root', createdAt: 1, updatedAt: 2, name: 'Chat', metadata: { path: '/repo', conversationActiveSessionId: 'current' } },
            { id: 'old', createdAt: 2, updatedAt: 3, name: 'Old worker', metadata: { path: '/repo', conversationRootSessionId: 'root', lifecycleState: 'archived' } },
            { id: 'current', createdAt: 3, updatedAt: 4, name: 'Current worker', metadata: { path: '/repo', conversationRootSessionId: 'root', lifecycleState: 'archived' } },
        ];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionHistoryList variant="sidebar" />); });
        expect(renderer.root.findAllByType('CompactSessionRow').map((node: any) => node.props.session.id)).toEqual(['root']);
        act(() => renderer.unmount());
    });

    it('ignores native offset changes without a drag and consumes one native drag', () => {
        mocks.platform = 'ios';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionHistoryList variant="sidebar" />); });

        const list = renderer.root.findByType('FlatList');
        expect(list.props.onEndReachedThreshold).toBe(0.5);
        act(() => list.props.onScroll?.({ nativeEvent: { contentOffset: { y: 120 } } }));
        act(() => list.props.onEndReached());
        expect(mocks.loadNextSessionHistoryPage).not.toHaveBeenCalled();
        act(() => list.props.onScrollBeginDrag());
        act(() => list.props.onEndReached());
        expect(mocks.loadNextSessionHistoryPage).toHaveBeenCalledTimes(1);
        act(() => list.props.onScroll?.({ nativeEvent: { contentOffset: { y: 240 } } }));
        act(() => list.props.onEndReached());
        expect(mocks.loadNextSessionHistoryPage).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
    });

    it('clears pending intent and prior offset when the internal list disappears and reappears', () => {
        const previous = mocks.sessions;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionHistoryList variant="page" />); });

        const initialList = renderer.root.findByType('FlatList');
        act(() => initialList.props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));

        mocks.sessions = [];
        act(() => renderer.update(<SessionHistoryList variant="sidebar" />));
        expect(renderer.root.findAllByType('FlatList')).toHaveLength(0);

        mocks.sessions = previous;
        act(() => renderer.update(<SessionHistoryList variant="page" />));
        const remountedList = renderer.root.findByType('FlatList');
        act(() => remountedList.props.onEndReached());
        expect(mocks.loadNextSessionHistoryPage).not.toHaveBeenCalled();

        act(() => remountedList.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }));
        act(() => remountedList.props.onEndReached());
        expect(mocks.loadNextSessionHistoryPage).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('consumes a changed Web scroll offset once without a native drag callback', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionHistoryList variant="sidebar" />); });

        const list = renderer.root.findByType('FlatList');
        act(() => list.props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));
        expect(mocks.loadNextSessionHistoryPage).not.toHaveBeenCalled();
        act(() => list.props.onEndReached());
        expect(mocks.loadNextSessionHistoryPage).toHaveBeenCalledTimes(1);

        act(() => list.props.onEndReached());
        expect(mocks.loadNextSessionHistoryPage).toHaveBeenCalledTimes(1);

        act(() => renderer.unmount());
    });

    it.each(['page', 'sidebar'] as const)('starts empty/history-only %s once interactive and pages only after explicit scroll', async variant => {
        const previous = mocks.sessions;
        mocks.sessions = [];
        mocks.pathname = '/new';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionHistoryList variant={variant} />); });
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mocks.sessionRouteBecameInteractive.mock.calls.length).toBe(1);
        mocks.sessions = previous;
        act(() => { renderer.update(<SessionHistoryList variant={variant} key="history-arrived" />); });
        const list = renderer.root.findByType('FlatList');
        act(() => list.props.onEndReached?.());
        expect(mocks.loadNextSessionHistoryPage.mock.calls.length).toBe(0);
        act(() => { list.props.onScrollBeginDrag?.(); list.props.onEndReached?.(); });
        expect(mocks.loadNextSessionHistoryPage.mock.calls.length).toBe(1);
        act(() => list.props.onEndReached?.());
        expect(mocks.loadNextSessionHistoryPage.mock.calls.length).toBe(1);
        act(() => renderer.unmount());
    });

    it('shows archive-specific empty guidance when no archived conversations exist', () => {
        mocks.sessions = [{
            id: 'regular',
            updatedAt: Date.UTC(2026, 8, 5, 9),
            name: 'Regular session',
            metadata: { lifecycleState: 'running' },
        }];
        let renderer: any;

        act(() => { renderer = TestRenderer.create(<SessionHistoryList variant="sidebar" />); });

        expect(renderer.root.findByType('EmptySessionsTablet').props).toMatchObject({
            description: 'sessionHistory.archiveEmptyDescription',
            icon: 'archive-outline',
            showNewSessionAction: false,
            title: 'sessionHistory.archiveEmpty',
        });

        act(() => renderer.unmount());
        vi.useRealTimers();
    });

    it('keeps requesting older history pages when a page only repeats already-loaded active conversations', async () => {
        mocks.sessions = [{
            id: 'already-loaded-active',
            updatedAt: Date.UTC(2026, 8, 5, 9),
            name: 'Already loaded active session',
            metadata: { lifecycleState: 'running' },
        }];
        mocks.loadNextSessionHistoryPage
            .mockResolvedValueOnce(true)
            .mockImplementationOnce(async () => {
                mocks.sessions = [
                    ...mocks.sessions,
                    {
                        id: 'archived-page-2',
                        updatedAt: Date.UTC(2026, 7, 25, 9),
                        name: 'Archived page 2',
                        metadata: { lifecycleState: 'archived' },
                    },
                ];
                return false;
            });
        let renderer: any;

        await act(async () => {
            renderer = TestRenderer.create(<SessionHistoryList variant="sidebar" />);
        });
        expect(mocks.loadNextSessionHistoryPage).toHaveBeenCalledTimes(2);

        await act(async () => {
            renderer.update(<SessionHistoryList variant="page" />);
        });
        expect(mocks.loadNextSessionHistoryPage).toHaveBeenCalledTimes(2);
        expect(renderer.root.findByProps({ testID: 'session-history-row-archived-page-2' })).toBeDefined();

        act(() => renderer.unmount());
    });
});
