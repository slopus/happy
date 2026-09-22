import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { DesktopSidebarSessionsNavigation } from './DesktopSidebarSessionsNavigation';
import { DesktopTagActionsPopover, DesktopTagDetailDialog } from './DesktopTagDialog';
import { useSessionListSyncState } from '@/sync/sessionListSyncState';

const mocks = vi.hoisted(() => {
    const state = {
        bootstrap: vi.fn(),
        history: vi.fn(),
        confirm: vi.fn(),
        navigate: vi.fn(),
        navigateToSession: vi.fn(),
        updateOrganization: vi.fn(),
        setAgentType: vi.fn(),
        setInput: vi.fn(),
        setMachineId: vi.fn(),
        setPath: vi.fn(),
        moveToPinned: vi.fn(),
        setDesktopSidebarListMode: vi.fn(),
        setDesktopSidebarMode: vi.fn(),
        setSidebarGroupExpansion: vi.fn(),
        setTagDetailsHideArchived: vi.fn(),
        pinnedOrder: [] as string[],
        organization: null as any,
        desktopSidebarListMode: 'projects',
        desktopSidebarMode: 'projects',
        sidebarGroupExpansion: {} as Record<string, boolean>,
        tagDetailsHideArchived: false,
        sessions: [] as any[],
        archivedSessions: [] as any[],
        renderSidebarGroupExpansion: null as null | ((next: Record<string, boolean>) => void),
        renderOrganization: null as null | ((next: any) => void),
        sidebarUnassignedExpanded: false,
    };
    return Object.assign(state, {
        updateSidebarGroupExpansion(updater: (current: Record<string, boolean>) => Record<string, boolean>) {
            const next = updater(state.sidebarGroupExpansion);
            state.sidebarGroupExpansion = next;
            state.setSidebarGroupExpansion(next);
            state.renderSidebarGroupExpansion?.(next);
        },
    });
});

vi.mock('@/sync/sync', () => ({ sync: { bootstrapSessions: mocks.bootstrap, loadNextSessionHistoryPage: mocks.history } }));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    return {
        FlatList: ({ data, renderItem, ...props }: any) => ReactModule.createElement(
            'FlatList',
            props,
            data.map((item: any, index: number) => ReactModule.createElement(
                ReactModule.Fragment,
                { key: item.key },
                renderItem({ item, index }),
            )),
        ),
        Modal: 'Modal',
        Platform: { OS: 'web' },
        Pressable: ({ children, ...props }: any) => ReactModule.createElement(
            'Pressable',
            props,
            typeof children === 'function' ? children({ pressed: false }) : children,
        ),
        ScrollView: 'ScrollView',
        TextInput: 'TextInput',
        useWindowDimensions: () => ({ height: 900, width: 1440 }),
        View: 'View',
    };
});
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('expo-router', () => ({
    usePathname: () => '/session/session-1',
    useRouter: () => ({ navigate: mocks.navigate }),
}));
vi.mock('react-native-unistyles', () => ({
    mq: { only: { width: (min: number, max?: number) => `width-${min}-${max ?? 'up'}` } },
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({
            colors: {
                accent: '#078', button: { primary: { background: '#078', tint: '#fff' } }, divider: '#ddd',
                groupped: { sectionTitle: '#666' }, shadow: { color: '#000', opacity: 0.2 }, surface: '#fff',
                surfaceHigh: '#f5f5f5', surfacePressed: '#eee', surfaceSelected: '#e5e5e5', text: '#111', textSecondary: '#666',
            },
        }),
        absoluteFill: {},
    },
    useUnistyles: () => ({ theme: { colors: {
        accent: '#078', deleteAction: '#c66', particle: { accent: '#86b' }, success: '#498',
        textLink: '#48b', textSecondary: '#666', surfaceHigh: '#eee', button: { primary: { tint: '#fff' } },
    } } }),
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigateToSession }));
vi.mock('@/hooks/useNewSessionDraft', () => ({ useNewSessionDraft: { getState: () => ({
    setAgentType: mocks.setAgentType,
    setInput: mocks.setInput,
    setMachineId: mocks.setMachineId,
    setPath: mocks.setPath,
}) } }));
vi.mock('@/hooks/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => [{ type: 'active-sessions', sessions: mocks.sessions }],
}));

const sessionFixture = (id: string, name: string) => ({
        id, name, subtitle: 'Happy', avatarId: 'a', flavor: 'codex', state: 'idle',
        isConnected: true, hasDraft: false, active: true, archived: false, machineId: 'mac', path: '~/happy', homeDir: '~',
        completedTodosCount: 0, totalTodosCount: 0, hasUnread: false,
    });

vi.mock('@/hooks/useSessionManagementPreferences', () => ({
    useSessionManagementPreferences: () => ({
        preferences: { pinnedOrder: mocks.pinnedOrder, focusOrder: [] },
        moveToPinned: mocks.moveToPinned,
    }),
}));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm, prompt: vi.fn() } }));
vi.mock('@/sync/storage', async () => {
    const ReactModule = await import('react');
    return {
        useAllMachines: () => [{ id: 'mac', active: true, lastActiveAt: Date.now(), metadata: { displayName: 'Mac mini', homeDir: '/Users/test' } }],
        useLocalSettingMutable: (name: string) => {
            const initialValue = name === 'desktopSidebarMode'
                ? mocks.desktopSidebarMode
                : name === 'desktopSidebarListMode'
                    ? mocks.desktopSidebarListMode
                    : name === 'sidebarGroupExpansion'
                        ? mocks.sidebarGroupExpansion
                        : name === 'tagDetailsHideArchived'
                            ? mocks.tagDetailsHideArchived
                        : name === 'sidebarUnassignedExpanded'
                            ? mocks.sidebarUnassignedExpanded
                        : mocks.organization;
            const [value, setValue] = ReactModule.useState(initialValue);
            if (name === 'sidebarGroupExpansion') mocks.renderSidebarGroupExpansion = setValue;
            const spy = name === 'desktopSidebarMode'
                ? mocks.setDesktopSidebarMode
                : name === 'desktopSidebarListMode'
                    ? mocks.setDesktopSidebarListMode
                    : name === 'sidebarGroupExpansion'
                        ? mocks.setSidebarGroupExpansion
                        : name === 'tagDetailsHideArchived'
                            ? mocks.setTagDetailsHideArchived
                        : undefined;
            return [value, (next: any) => {
                spy?.(next);
                if (name === 'sidebarGroupExpansion') mocks.sidebarGroupExpansion = next;
                if (name === 'tagDetailsHideArchived') mocks.tagDetailsHideArchived = next;
                if (name === 'sidebarUnassignedExpanded') mocks.sidebarUnassignedExpanded = next;
                setValue(next);
            }];
        },
        useLocalSettingUpdater: () => mocks.updateSidebarGroupExpansion,
        useSessionListViewData: () => [
            { type: 'active-sessions', sessions: mocks.sessions },
            ...mocks.archivedSessions.map((session) => ({ type: 'session', session })),
        ],
        useSetting: () => {
            const [value, setValue] = ReactModule.useState(mocks.organization);
            mocks.renderOrganization = setValue;
            return value;
        },
        useSettingUpdater: () => mocks.updateOrganization,
    };
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./MainView', () => ({ MainView: 'MainView' }));
vi.mock('./SessionHistoryList', () => ({
    SessionHistoryList: ({ variant }: { variant: string }) => React.createElement('SessionHistoryList', {
        testID: variant === 'sidebar' ? 'desktop-sidebar-archive-list' : 'session-archive-list',
        variant,
    }),
}));
vi.mock('./ActiveSessionsGroupCompact', () => ({ CompactSessionRow: 'CompactSessionRow' }));
vi.mock('./SessionConfigPanel', () => ({ PathPickerContent: 'PathPickerContent', PickerContent: 'PickerContent' }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessionUtils', () => ({ formatPathRelativeToHome: (path: string) => path }));

describe('DesktopSidebarSessionsNavigation', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        useSessionListSyncState.setState({ bootstrap: 'idle', history: 'idle' });
        vi.clearAllMocks();
        mocks.organization = {
            lists: [
                { id: 'happy', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'mac', path: '~/happy', defaultAgent: 'codex', createdAt: 1 },
                { id: 'advisor', name: 'Advisor', kind: 'agent', color: 'pink', createdAt: 2 },
            ],
            tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
            sessions: { 'session-1': { listId: 'happy', tagIds: ['product'] } },
        };
        mocks.sessions = [sessionFixture('session-1', 'Sidebar work')];
        mocks.archivedSessions = [];
        mocks.pinnedOrder = [];
        mocks.desktopSidebarListMode = 'projects';
        mocks.desktopSidebarMode = 'projects';
        mocks.sidebarGroupExpansion = {};
        mocks.tagDetailsHideArchived = false;
        mocks.renderSidebarGroupExpansion = null;
        mocks.renderOrganization = null;
        mocks.sidebarUnassignedExpanded = false;
    });

    it.each(['projects', 'lists', 'timeline', 'history'])('exposes recoverable list failure in %s without hiding the current view', (mode) => {
        mocks.desktopSidebarMode = mode;
        mocks.bootstrap.mockImplementation(() => {
            useSessionListSyncState.setState({ bootstrap: 'loading' });
            return Promise.resolve();
        });
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => { useSessionListSyncState.setState({ bootstrap: 'error' }); });
        const retry = renderer.root.findAllByProps({ accessibilityRole: 'button', accessibilityLabel: 'common.retry' });
        expect(retry.length).toBeGreaterThan(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-timeline' }).length).toBeGreaterThan(0);
        act(() => retry[0].props.onPress());
        expect(useSessionListSyncState.getState().bootstrap).toBe('loading');
        act(() => renderer.unmount());
    });

    it('keeps Projects as default and does not navigate for sidebar-only organization actions', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });

        expect(renderer.root.findAllByType('MainView')).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'desktop-sidebar-tab-projects' }).props.accessibilityState).toEqual({ selected: true });

        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        expect(renderer.root.findAllByType('MainView')).toHaveLength(0);
        expect(renderer.root.findByType('FlatList').props).toMatchObject({
            initialNumToRender: 18,
            maxToRenderPerBatch: 12,
            windowSize: 7,
        });

        act(() => renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'tag-detail-dialog-product' })).toBeDefined();
        expect(mocks.moveToPinned).not.toHaveBeenCalled();
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('keeps List deletion inside the editor instead of exposing a row trash action', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        expect(renderer.root.findAllByProps({ testID: 'sidebar-delete-list-happy' })).toHaveLength(0);

        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-happy' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-delete-list' }).length).toBeGreaterThan(0);
        act(() => renderer.unmount());
    });

    it('renders sessions in a List through the shared session row and keeps organizing in its context action', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        const listSession = renderer.root.findByType('CompactSessionRow');
        expect(listSession.props).toMatchObject({
            nested: true,
            session: expect.objectContaining({ id: 'session-1' }),
        });
        expect(listSession.props.onOrganize).toEqual(expect.any(Function));
        expect(renderer.root.findAllByProps({ testID: 'organize-session-session-1' })).toHaveLength(0);

        act(() => listSession.props.onOrganize());
        expect(renderer.root.findByProps({ testID: 'organize-session-save' })).toBeDefined();
        act(() => renderer.unmount());
    });

    it('opens a Tag detail dialog and groups every tagged session by its List', () => {
        mocks.sessions = [
            sessionFixture('session-1', 'Happy work'),
            sessionFixture('session-2', 'Advisor work'),
            sessionFixture('session-3', 'Loose work'),
        ];
        mocks.organization = {
            ...mocks.organization,
            sessions: {
                'session-1': { listId: 'happy', tagIds: ['product'] },
                'session-2': { listId: 'advisor', tagIds: ['product'] },
                'session-3': { listId: null, tagIds: ['product'] },
            },
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'sidebar-tag-row-product' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'sidebar-tag-count-product' }).props.children).toBe(3);
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'tag-detail-dialog-product' })).toBeDefined();
        expect(renderer.root.findAllByType('Modal').find((node: any) => node.props.visible)?.props.accessibilityLabel).toBe('#product');
        expect(renderer.root.findAllByProps({ testID: 'desktop-dialog-backdrop' }).every((node: any) => node.props.accessible === false)).toBe(true);
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'sidebarLists.close' }).every((node: any) => node.props.accessibilityRole === 'button')).toBe(true);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-close-tag-filter' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'sidebar-list-happy' })).toBeDefined();
        expect(renderer.root.findAll((node: any) => typeof node.props.testID === 'string' && node.props.testID.startsWith('tag-detail-group-')).map((node: any) => node.props.testID)).toEqual([
            'tag-detail-group-happy',
            'tag-detail-group-advisor',
            'tag-detail-group-unassigned',
        ]);
        expect(renderer.root.findAllByType('CompactSessionRow').filter((node: any) => !node.props.testID).map((node: any) => node.props.session.id)).toEqual([
            'session-1',
            'session-2',
            'session-3',
        ]);

        act(() => renderer.root.findByProps({ testID: 'tag-detail-toggle-happy' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'tag-detail-toggle-happy' }).props.accessibilityState).toEqual({ expanded: false });
        expect(renderer.root.findAllByProps({ testID: 'tag-detail-session-session-1' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('collects archived Tag sessions at the bottom and persists the dialog-only hide setting', () => {
        mocks.sessions = [sessionFixture('session-1', 'Happy work')];
        mocks.archivedSessions = [
            { ...sessionFixture('session-2', 'Archived Happy work'), archived: true },
            { ...sessionFixture('session-3', 'Archived loose work'), archived: true },
        ];
        mocks.organization = {
            ...mocks.organization,
            sessions: {
                'session-1': { listId: 'happy', tagIds: ['product'] },
                'session-2': { listId: 'happy', tagIds: ['product'] },
                'session-3': { listId: null, tagIds: ['product'] },
                'session-not-loaded': { listId: null, tagIds: ['product'] },
            },
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'sidebar-tag-count-product' }).props.children).toBe(4);
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());
        expect(renderer.root.findByType(DesktopTagDetailDialog).props.sessionCount).toBe(4);
        expect(renderer.root.findByProps({ testID: 'tag-detail-partially-loaded' }).props.children).toBe('sidebarLists.tagSessionsPartiallyLoaded');
        expect(renderer.root.findAll((node: any) => typeof node.props.testID === 'string' && node.props.testID.startsWith('tag-detail-group-')).map((node: any) => node.props.testID)).toEqual([
            'tag-detail-group-happy',
            'tag-detail-group-archived',
        ]);
        expect(renderer.root.findAllByProps({ testID: 'tag-detail-session-session-2' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'tag-detail-session-session-3' })).toHaveLength(1);

        act(() => renderer.root.findByProps({ testID: 'tag-detail-menu-product' }).props.onPress({
            currentTarget: { getBoundingClientRect: () => ({ bottom: 140, right: 1010 }) },
            nativeEvent: {},
        }));
        expect(renderer.root.findByProps({ testID: 'tag-detail-actions-popover-product' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'tag-detail-toggle-archived-visibility' }).props.accessibilityLabel).toBe('sidebarLists.hideArchived');
        act(() => renderer.root.findByProps({ testID: 'tag-detail-toggle-archived-visibility' }).props.onPress());

        expect(mocks.setTagDetailsHideArchived).toHaveBeenCalledWith(true);
        expect(renderer.root.findAllByProps({ testID: 'tag-detail-group-archived' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'sidebar-tag-count-product' }).props.children).toBe(4);
        expect(renderer.root.findAllByProps({ testID: 'tag-detail-actions-popover-product' })).toHaveLength(0);
        act(() => renderer.unmount());

        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'tag-detail-group-archived' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'tag-detail-menu-product' }).props.onPress({
            currentTarget: { getBoundingClientRect: () => ({ bottom: 140, right: 1010 }) },
            nativeEvent: {},
        }));
        expect(renderer.root.findByProps({ testID: 'tag-detail-toggle-archived-visibility' }).props.accessibilityLabel).toBe('sidebarLists.showArchived');
        act(() => renderer.unmount());
    });

    it('explains when Tag associations exist before their historical sessions load', () => {
        mocks.sessions = [];
        mocks.archivedSessions = [];
        mocks.organization = {
            ...mocks.organization,
            sessions: { 'session-not-loaded': { listId: 'happy', tagIds: ['product'] } },
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'sidebar-tag-count-product' }).props.children).toBe(1);
        expect(renderer.root.findByProps({ testID: 'tag-detail-sessions-not-loaded' }).props.children).toBe('sidebarLists.tagSessionsNotLoaded');
        expect(renderer.root.findAllByProps({ children: 'sidebarLists.noTaggedSessions' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('explains when an archive-only Tag is hidden instead of claiming it has no sessions', () => {
        mocks.sessions = [];
        mocks.archivedSessions = [{ ...sessionFixture('session-2', 'Archived work'), archived: true }];
        mocks.organization = {
            ...mocks.organization,
            sessions: { 'session-2': { listId: 'happy', tagIds: ['product'] } },
        };
        mocks.tagDetailsHideArchived = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'tag-detail-archived-hidden' }).props.children).toBe('sidebarLists.archivedSessionsHidden');
        expect(renderer.root.findAllByProps({ children: 'sidebarLists.noTaggedSessions' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('does not carry an open detail menu to a different Tag after remote deletion', () => {
        mocks.organization = {
            ...mocks.organization,
            tags: [
                ...mocks.organization.tags,
                { id: 'research', name: 'research', color: 'purple', createdAt: 2 },
            ],
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'tag-detail-menu-product' }).props.onPress({
            currentTarget: { getBoundingClientRect: () => ({ bottom: 140, right: 1010 }) },
            nativeEvent: {},
        }));
        expect(renderer.root.findByProps({ testID: 'tag-detail-actions-popover-product' })).toBeDefined();

        act(() => mocks.renderOrganization?.({
            ...mocks.organization,
            tags: mocks.organization.tags.filter((tag: any) => tag.id !== 'product'),
        }));
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-research' }).props.onPress());

        expect(renderer.root.findAllByProps({ testID: 'tag-detail-actions-popover-research' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('closes the Tag detail actions menu before asking to delete the Tag', async () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'tag-detail-menu-product' }).props.onPress({
            currentTarget: { getBoundingClientRect: () => ({ bottom: 140, right: 1010 }) },
            nativeEvent: {},
        }));

        let resolveConfirm: ((value: boolean) => void) | undefined;
        mocks.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
        act(() => renderer.root.findByProps({ testID: 'tag-detail-delete-product' }).props.onPress());

        expect(renderer.root.findAllByProps({ testID: 'tag-detail-actions-popover-product' })).toHaveLength(0);
        expect(mocks.confirm).toHaveBeenCalledOnce();
        await act(async () => {
            resolveConfirm?.(false);
            await Promise.resolve();
        });
        expect(mocks.updateOrganization).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('deletes only a Tag and its associations from the Tag actions menu', async () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-menu-product' }).props.onPress({
            currentTarget: { getBoundingClientRect: () => ({ bottom: 260, right: 410 }) },
            nativeEvent: {},
        }));

        expect(renderer.root.findByProps({ testID: 'tag-actions-popover-product' })).toBeDefined();
        expect(renderer.root.findByType(DesktopTagActionsPopover).props.anchor).toEqual({ tagId: 'product', x: 410, y: 260 });
        expect(renderer.root.findAllByType('Modal').find((node: any) => node.props.visible)?.props.accessibilityLabel).toBe('sidebarLists.tagActions product');
        expect(renderer.root.findByProps({ testID: 'tag-actions-backdrop' }).props.accessible).toBe(false);
        expect(renderer.root.findAllByProps({ testID: 'tag-detail-dialog-product' })).toHaveLength(0);
        let resolveConfirm: ((value: boolean) => void) | undefined;
        mocks.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
        act(() => renderer.root.findByProps({ testID: 'sidebar-delete-tag-product' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'tag-actions-popover-product' })).toHaveLength(0);
        await act(async () => {
            resolveConfirm?.(true);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.confirm).toHaveBeenCalledWith(
            'sidebarLists.deleteTag',
            'sidebarLists.deleteTagConfirm',
            expect.objectContaining({ destructive: true }),
        );
        const remove = mocks.updateOrganization.mock.calls.at(-1)?.[0];
        const removed = remove(mocks.organization);
        expect(removed.tags).toEqual([]);
        expect(removed.sessions['session-1']).toEqual({ listId: 'happy', tagIds: [] });
        expect(mocks.sessions.map((session) => session.id)).toEqual(['session-1']);
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('keeps Unassigned collapsed by default and restores the device-local expansion state', () => {
        mocks.organization = {
            ...mocks.organization,
            sessions: { 'session-1': { listId: null, tagIds: [] } },
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        const unassigned = renderer.root.findByProps({ testID: 'sidebar-list-unassigned' });
        expect(unassigned.props.accessibilityState).toEqual({ expanded: false });
        expect(renderer.root.findAllByProps({ testID: 'organized-session-session-1' })).toHaveLength(0);

        act(() => unassigned.props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-unassigned' }).props.accessibilityState).toEqual({ expanded: true });
        expect(renderer.root.findAllByProps({ testID: 'organized-session-session-1' }).length).toBeGreaterThan(0);
        act(() => renderer.unmount());

        expect(mocks.setSidebarGroupExpansion).toHaveBeenCalledWith({ 'lists:unassigned': true });
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-unassigned' }).props.accessibilityState).toEqual({ expanded: true });
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-unassigned' }).props.onPress());
        act(() => renderer.unmount());

        expect(mocks.setSidebarGroupExpansion).toHaveBeenLastCalledWith({});
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-unassigned' }).props.accessibilityState).toEqual({ expanded: false });
        act(() => renderer.unmount());
    });

    it('restores each device-local List expansion state after remount', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        const list = renderer.root.findByProps({ testID: 'sidebar-list-advisor' });
        expect(list.props.accessibilityState).toEqual({ expanded: false });
        act(() => list.props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-advisor' }).props.accessibilityState).toEqual({ expanded: true });
        act(() => renderer.unmount());

        expect(mocks.setSidebarGroupExpansion).toHaveBeenCalledWith({
            'lists:happy': true,
            'lists:advisor': true,
        });
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-advisor' }).props.accessibilityState).toEqual({ expanded: true });
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-advisor' }).props.onPress());
        act(() => renderer.unmount());

        expect(mocks.setSidebarGroupExpansion).toHaveBeenLastCalledWith({ 'lists:happy': true });
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-advisor' }).props.accessibilityState).toEqual({ expanded: false });
        act(() => renderer.unmount());
    });

    it('allows the selected List to stay collapsed after its automatic reveal', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        const list = renderer.root.findByProps({ testID: 'sidebar-list-happy' });
        expect(list.props.accessibilityState).toEqual({ expanded: true });
        act(() => list.props.onPress());

        expect(renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.accessibilityState).toEqual({ expanded: false });
        expect(mocks.sidebarGroupExpansion).toEqual({});
        act(() => renderer.unmount());
    });

    it('does not reopen the selected List when unrelated organization metadata changes', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.accessibilityState).toEqual({ expanded: false });

        mocks.organization = {
            ...mocks.organization,
            sessions: {
                ...mocks.organization.sessions,
                'session-1': { listId: 'happy', tagIds: [] },
            },
        };
        act(() => mocks.renderOrganization?.(mocks.organization));

        expect(renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.accessibilityState).toEqual({ expanded: false });
        expect(mocks.sidebarGroupExpansion).toEqual({});
        act(() => renderer.unmount());
    });

    it('preserves expansion overrides when two groups are toggled in one batch', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        act(() => {
            renderer.root.findByProps({ testID: 'sidebar-list-advisor' }).props.onPress();
            renderer.root.findByProps({ testID: 'sidebar-list-unassigned' }).props.onPress();
        });

        expect(mocks.sidebarGroupExpansion).toEqual({
            'lists:happy': true,
            'lists:advisor': true,
            'lists:unassigned': true,
        });
        expect(renderer.root.findByProps({ testID: 'sidebar-list-advisor' }).props.accessibilityState).toEqual({ expanded: true });
        expect(renderer.root.findByProps({ testID: 'sidebar-list-unassigned' }).props.accessibilityState).toEqual({ expanded: true });
        act(() => renderer.unmount());
    });

    it('exposes Timeline beside Projects and Lists as a top-level view', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });

        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-timeline' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'desktop-sidebar-tab-timeline' }).props.accessibilityState).toEqual({ selected: true });
        expect(renderer.root.findByType('MainView').props.sessionListLayout).toBe('time');
        expect(mocks.setDesktopSidebarListMode).toHaveBeenCalledWith('timeline');
        act(() => renderer.unmount());
    });

    it('renders an archive-only surface without the Projects / Lists / Timeline tabs', () => {
        mocks.desktopSidebarMode = 'archive';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });

        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-projects' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-lists' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-timeline' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MainView')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'desktop-sidebar-archive-list' })).toBeDefined();
        act(() => renderer.unmount());
    });

    it('shows pinned conversations in their own Lists section without duplicating them', () => {
        mocks.pinnedOrder = ['session-1'];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'sidebar-pinned-section' })).toBeDefined();
        expect(renderer.root.findAllByType('CompactSessionRow')).toHaveLength(1);
        expect(renderer.root.findByType('CompactSessionRow').props.session.id).toBe('session-1');
        expect(renderer.root.findAllByProps({ testID: 'organized-session-session-1' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('carries the owning List into the explicit new-session route', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());

        const createButton = renderer.root.findByProps({ testID: 'sidebar-new-session-happy' });
        act(() => createButton.props.onPress());

        expect(mocks.setMachineId).toHaveBeenCalledWith('mac');
        expect(mocks.setPath).toHaveBeenCalledWith('~/happy');
        expect(mocks.setAgentType).toHaveBeenCalledWith('codex');
        expect(mocks.navigate).toHaveBeenCalledWith({
            pathname: '/new',
            params: { sidebarListId: 'happy' },
        });
        act(() => renderer.unmount());
    });

    it('searches with # and creates a Tag only when the organizer is saved', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByType('CompactSessionRow').props.onOrganize());

        const input = renderer.root.findByProps({ testID: 'organize-tag-input' });
        act(() => input.props.onChangeText('#'));
        expect(renderer.root.findByProps({ testID: 'organize-tag-result-product' })).toBeDefined();

        act(() => renderer.root.findByProps({ testID: 'organize-tag-input' }).props.onChangeText('#research'));
        act(() => renderer.root.findByProps({ testID: 'organize-create-tag' }).props.onPress());
        expect(mocks.updateOrganization).not.toHaveBeenCalled();

        act(() => renderer.root.findByProps({ testID: 'organize-session-save' }).props.onPress());
        const save = mocks.updateOrganization.mock.calls.at(-1)?.[0];
        const next = save({
            lists: [{ id: 'happy', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'mac', path: '~/happy', defaultAgent: 'codex', createdAt: 1 }],
            tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
            sessions: { 'session-1': { listId: 'happy', tagIds: ['product'] } },
        });
        const research = next.tags.find((tag: any) => tag.name === 'research');
        expect(research).toBeDefined();
        expect(next.sessions['session-1'].tagIds).toEqual(['product', research.id]);
        act(() => renderer.unmount());
    });

    it('discards a newly drafted Tag when the organizer is cancelled', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByType('CompactSessionRow').props.onOrganize());
        act(() => renderer.root.findByProps({ testID: 'organize-tag-input' }).props.onChangeText('#temporary'));
        act(() => renderer.root.findByProps({ testID: 'organize-create-tag' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'organize-session-cancel' }).props.onPress());

        expect(mocks.updateOrganization).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('disables unselected results and explains the limit when a session already has 100 Tags', () => {
        const selectedTags = Array.from({ length: 100 }, (_, index) => ({
            id: `selected-${index}`,
            name: `selected-${index}`,
            color: 'blue',
            createdAt: index,
        }));
        mocks.organization = {
            lists: [],
            tags: [...selectedTags, { id: 'available', name: 'available', color: 'green', createdAt: 101 }],
            sessions: { 'session-1': { listId: null, tagIds: selectedTags.map((tag) => tag.id) } },
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-unassigned' }).props.onPress());
        act(() => renderer.root.findByType('CompactSessionRow').props.onOrganize());

        act(() => renderer.root.findByProps({ testID: 'organize-tag-input' }).props.onChangeText('#available'));
        expect(renderer.root.findByProps({ testID: 'organize-tag-result-available' }).props).toMatchObject({
            disabled: true,
            accessibilityState: { disabled: true, selected: false },
        });

        act(() => renderer.root.findByProps({ testID: 'organize-tag-input' }).props.onChangeText('#brand-new'));
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'sidebarLists.tagLimitReached')).toBe(true);
        act(() => renderer.unmount());
    });

    it('opens the List editor from the pencil and uses remote machine and directory pickers', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-happy' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'sidebar-list-name-input' }).props.value).toBe('Happy');
        expect(renderer.root.findAllByType('PickerContent').length).toBeGreaterThan(0);
        expect(renderer.root.findByProps({ testID: 'sidebar-list-directory-picker' }).findByType('PathPickerContent').props).toMatchObject({
            machineId: 'mac',
            manualInput: false,
        });
        expect(renderer.root.findAllByProps({ testID: 'sidebar-delete-list-happy' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-directory-none' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-directory-picker' }).findByType('PathPickerContent').props.value).toBe('');
        expect(renderer.root.findAllByProps({ testID: 'sidebar-delete-list' }).length).toBeGreaterThan(0);
        expect(mocks.navigate).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('creates a Workspace List from selected machine and remote directory values', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-create-list-button' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-name-input' }).props.onChangeText('Remote project'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-machine-picker' }).findByType('PickerContent').props.onSelect('mac'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-directory-picker' }).findByType('PathPickerContent').props.onChangeValue('/Users/test/project'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-create-list-submit' }).props.onPress());

        const create = mocks.updateOrganization.mock.calls.at(-1)?.[0];
        const created = create({ lists: [], tags: [], sessions: {} });
        expect(created.lists).toEqual([expect.objectContaining({
            kind: 'workspace',
            machineId: 'mac',
            name: 'Remote project',
            path: '/Users/test/project',
        })]);
        act(() => renderer.unmount());
    });

    it('renames and deletes Lists without launching a conversation', async () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-happy' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-name-input' }).props.onChangeText('Happy renamed'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-submit' }).props.onPress());

        const rename = mocks.updateOrganization.mock.calls.at(-1)?.[0];
        const current = {
            lists: [
                { id: 'happy', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'mac', path: '~/happy', defaultAgent: 'codex', createdAt: 1 },
                { id: 'advisor', name: 'Advisor', kind: 'agent', color: 'pink', createdAt: 2 },
            ],
            tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
            sessions: { 'session-1': { listId: 'happy', tagIds: ['product'] } },
        } as any;
        expect(rename(current).lists[0].name).toBe('Happy renamed');

        mocks.confirm.mockResolvedValueOnce(true);
        await act(async () => {
            renderer.root.findByProps({ testID: 'sidebar-edit-list-happy' }).props.onPress();
            renderer.root.findByProps({ testID: 'sidebar-delete-list' }).props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });
        const remove = mocks.updateOrganization.mock.calls.at(-1)?.[0];
        const removed = remove(current);
        expect(removed.lists.map((list: any) => list.id)).toEqual(['advisor']);
        expect(removed.sessions['session-1']).toEqual({ listId: null, tagIds: ['product'] });
        expect(mocks.navigate).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('launches Agent Lists in Ask mode without injecting a built-in prompt', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-lists' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-advisor' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-advisor' }).props.onPress());
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'newSession.askMode' })[0].props.accessibilityState).toEqual({ checked: true, disabled: true });
        act(() => renderer.root.findByProps({ testID: 'sidebar-create-list-cancel' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-new-session-advisor' }).props.onPress());

        expect(mocks.setAgentType).toHaveBeenCalledWith('ask');
        expect(mocks.setInput).toHaveBeenCalledWith('');
        expect(mocks.setMachineId).not.toHaveBeenCalled();
        expect(mocks.setPath).not.toHaveBeenCalled();
        expect(mocks.navigate).toHaveBeenCalledWith({
            pathname: '/new',
            params: { sidebarListId: 'advisor' },
        });
        act(() => renderer.unmount());
    });

});
