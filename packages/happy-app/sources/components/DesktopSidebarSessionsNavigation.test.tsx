import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { DesktopSidebarSessionsNavigation } from './DesktopSidebarSessionsNavigation';

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    navigate: vi.fn(),
    navigateToSession: vi.fn(),
    updateOrganization: vi.fn(),
    setAgentType: vi.fn(),
    setInput: vi.fn(),
    setMachineId: vi.fn(),
    setPath: vi.fn(),
    moveToPinned: vi.fn(),
    pinnedOrder: [] as string[],
    organization: null as any,
    desktopSidebarMode: 'projects',
}));

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
    useVisibleSessionListViewData: () => [{ type: 'active-sessions', sessions: [{
        id: 'session-1', name: 'Sidebar work', subtitle: 'Happy', avatarId: 'a', flavor: 'codex', state: 'idle',
        isConnected: true, hasDraft: false, active: true, archived: false, machineId: 'mac', path: '~/happy', homeDir: '~',
        completedTodosCount: 0, totalTodosCount: 0, hasUnread: false,
    }] }],
}));
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
        useLocalSettingMutable: (name: string) => ReactModule.useState(name === 'desktopSidebarMode' ? mocks.desktopSidebarMode : mocks.organization),
        useSetting: () => mocks.organization,
        useSettingUpdater: () => mocks.updateOrganization,
    };
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./MainView', () => ({ MainView: 'MainView' }));
vi.mock('./SessionHistoryList', () => ({
    SessionHistoryList: ({ variant }: { variant: string }) => React.createElement('SessionHistoryList', {
        testID: variant === 'sidebar' ? 'desktop-sidebar-history-list' : 'session-history-list',
        variant,
    }),
}));
vi.mock('./ActiveSessionsGroupCompact', () => ({ CompactSessionRow: 'CompactSessionRow' }));
vi.mock('./SessionConfigPanel', () => ({ PathPickerContent: 'PathPickerContent', PickerContent: 'PickerContent' }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessionUtils', () => ({ formatPathRelativeToHome: (path: string) => path }));

describe('DesktopSidebarSessionsNavigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.organization = {
            lists: [
                { id: 'happy', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'mac', path: '~/happy', defaultAgent: 'codex', createdAt: 1 },
                { id: 'advisor', name: 'Advisor', kind: 'agent', color: 'pink', createdAt: 2 },
            ],
            tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
            sessions: { 'session-1': { listId: 'happy', tagIds: ['product'] } },
        };
        mocks.pinnedOrder = [];
        mocks.desktopSidebarMode = 'projects';
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
        act(() => renderer.root.findByProps({ testID: 'pin-organized-session-session-1' }).props.onPress());

        expect(mocks.moveToPinned).toHaveBeenCalledWith('session-1');
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('exposes Timeline beside Projects and Lists as a top-level view', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });

        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-timeline' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'desktop-sidebar-tab-timeline' }).props.accessibilityState).toEqual({ selected: true });
        expect(renderer.root.findByType('MainView').props.sessionListLayout).toBe('time');
        act(() => renderer.unmount());
    });

    it('renders history in the list column without adding it to the Projects / Lists / Timeline tabs', () => {
        mocks.desktopSidebarMode = 'history';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation />); });

        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-projects' }).length).toBeGreaterThan(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-lists' }).length).toBeGreaterThan(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-timeline' }).length).toBeGreaterThan(0);
        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-history' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MainView')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'desktop-sidebar-history-list' })).toBeDefined();

        act(() => renderer.root.findByProps({ testID: 'desktop-sidebar-tab-projects' }).props.onPress());
        expect(renderer.root.findByType('MainView').props.sessionListLayout).toBe('projects');
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
        act(() => renderer.root.findByProps({ testID: 'organize-session-session-1' }).props.onPress());

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
        act(() => renderer.root.findByProps({ testID: 'organize-session-session-1' }).props.onPress());
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
        act(() => renderer.root.findByProps({ testID: 'organize-session-session-1' }).props.onPress());

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
        expect(renderer.root.findByProps({ testID: 'sidebar-delete-list-happy' }).props).toMatchObject({
            accessibilityRole: 'button',
        });
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
            renderer.root.findByProps({ testID: 'sidebar-delete-list-happy' }).props.onPress();
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
