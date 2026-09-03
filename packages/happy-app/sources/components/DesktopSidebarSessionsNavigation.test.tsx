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
    organizationCollapsed: false,
    organizationWidth: 220,
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
        useLocalSettingMutable: (key: string) => {
            if (key === 'desktopSidebarOrganizationCollapsed') {
                return ReactModule.useState(mocks.organizationCollapsed);
            }
            if (key === 'desktopSidebarOrganizationWidth') {
                return ReactModule.useState(mocks.organizationWidth);
            }
            return ReactModule.useState('when-populated');
        },
        useSetting: () => mocks.organization,
        useSettingUpdater: () => mocks.updateOrganization,
    };
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./MainView', () => ({ MainView: 'MainView' }));
vi.mock('./ActiveSessionsGroupCompact', async () => {
    const ReactModule = await import('react');
    return {
        CompactSessionRow: ({ onOrganize, session }: any) => ReactModule.createElement(
            'View',
            { testID: `session-row-${session.id}` },
            ReactModule.createElement('Pressable', { onPress: () => onOrganize?.(session), testID: `organize-session-${session.id}` }),
        ),
        STATUS_CONFIG: {
            idle: { color: '#666', dotColor: '#999', isPulsing: false },
            running: { color: '#078', dotColor: '#078', isPulsing: true },
            permission_required: { color: '#c80', dotColor: '#c80', isPulsing: true },
            failed: { color: '#c00', dotColor: '#c00', isPulsing: false },
            completed: { color: '#080', dotColor: '#080', isPulsing: false },
        },
    };
});
vi.mock('./ProjectSectionHeader', async () => {
    const ReactModule = await import('react');
    return {
        ProjectSectionHeader: ({ onToggle, testID }: any) => ReactModule.createElement('Pressable', { onPress: onToggle, testID }),
    };
});
vi.mock('./SessionConfigPanel', () => ({ PathPickerContent: 'PathPickerContent', PickerContent: 'PickerContent' }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessionUtils', () => ({ formatPathRelativeToHome: (path: string) => path, getSessionStateLabel: (state: string) => state }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => true }));

describe('DesktopSidebarSessionsNavigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.organization = {
            folders: [],
            lists: [
                { id: 'happy', name: 'Happy', kind: 'workspace', color: 'blue', machineId: 'mac', path: '~/happy', defaultAgent: 'codex', createdAt: 1 },
                { id: 'advisor', name: 'Advisor', kind: 'agent', color: 'pink', createdAt: 2 },
            ],
            tags: [{ id: 'product', name: 'product', color: 'green', createdAt: 1 }],
            sessions: { 'session-1': { listId: 'happy', tagIds: ['product'] } },
        };
        mocks.pinnedOrder = [];
        mocks.organizationCollapsed = false;
        mocks.organizationWidth = 220;
    });

    it('renders the organization and session panes together without legacy mode Tabs', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });

        expect(renderer.root.findByProps({ testID: 'sidebar-organization-pane' })).toBeDefined();
        expect(renderer.root.findByProps({ testID: 'sidebar-session-pane' })).toBeDefined();
        expect(renderer.root.findAllByProps({ testID: 'desktop-sidebar-tab-projects' })).toHaveLength(0);
        expect(renderer.root.findByType('FlatList').props).toMatchObject({
            initialNumToRender: 18,
            maxToRenderPerBatch: 12,
            windowSize: 7,
        });

        act(() => renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props['aria-selected']).toBe(true);
        act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props['aria-selected']).toBe(true);
        expect(renderer.root.findByProps({ testID: 'organize-session-session-1' })).toBeDefined();
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('uses Timeline as a first-class flat organization row', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });

        expect(renderer.root.findByProps({ testID: 'sidebar-organization-timeline' }).props['aria-selected']).toBe(true);
        expect(renderer.root.findByProps({ testID: 'sidebar-session-pane' })).toBeDefined();
        act(() => renderer.unmount());
    });

    it('collapses only the organization pane and keeps the session list available', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });

        const collapse = () => renderer.root.findByProps({ testID: 'sidebar-organization-collapse-button' });
        expect(collapse().props['aria-expanded']).toBe(true);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-organization-pane' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-session-pane' })).toHaveLength(1);

        act(() => collapse().props.onPress());
        expect(collapse().props['aria-expanded']).toBe(false);
        expect(collapse().props.accessibilityLabel).toBe('sidebarLists.showNavigation');
        expect(renderer.root.findAllByProps({ testID: 'sidebar-organization-pane' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-organization-resize-handle' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-session-pane' })).toHaveLength(1);

        act(() => collapse().props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-organization-pane' })).toHaveLength(1);
        act(() => renderer.unmount());
    });

    it('resizes the organization pane by pointer and keyboard within its limits', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });

        const handle = () => renderer.root.findByProps({ testID: 'sidebar-organization-resize-handle' });
        expect(handle().props['aria-valuenow']).toBe(220);
        act(() => {
            handle().props.onResponderGrant({ nativeEvent: { pageX: 220 } });
            handle().props.onResponderMove({ nativeEvent: { pageX: 260 } });
        });
        expect(handle().props['aria-valuenow']).toBe(260);
        act(() => handle().props.onResponderRelease());

        act(() => handle().props.onKeyDown({ key: 'End', preventDefault: vi.fn(), stopPropagation: vi.fn() }));
        expect(handle().props['aria-valuenow']).toBe(320);
        act(() => handle().props.onKeyDown({ key: 'Home', preventDefault: vi.fn(), stopPropagation: vi.fn() }));
        expect(handle().props['aria-valuenow']).toBe(176);

        act(() => renderer.unmount());
    });

    it('shows pinned conversations in their own Lists section without duplicating them', () => {
        mocks.pinnedOrder = ['session-1'];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });

        expect(renderer.root.findByProps({ testID: 'sidebar-organization-timeline' }).findAllByType('Text').at(-1)?.props.children).toBe(0);
        expect(renderer.root.findByProps({ testID: 'sidebar-organization-pinned' }).findAllByType('Text').at(-1)?.props.children).toBe(1);
        expect(renderer.root.findByProps({ testID: 'sidebar-list-happy' }).findAllByType('Text').at(-1)?.props.children).toBe(0);
        expect(renderer.root.findByProps({ testID: 'sidebar-tag-product' }).findAllByType('Text').at(-1)?.props.children).toBe(0);
        act(() => renderer.root.findByProps({ testID: 'sidebar-organization-pinned' }).props.onPress());

        expect(renderer.root.findAllByProps({ testID: 'session-row-session-1' }).length).toBeGreaterThan(0);
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-row-session-1' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('carries the owning List into the explicit new-session route', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.onPress());

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
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
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
            folders: [],
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
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
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
            folders: [],
            lists: [],
            tags: [...selectedTags, { id: 'available', name: 'available', color: 'green', createdAt: 101 }],
            sessions: { 'session-1': { listId: null, tagIds: selectedTags.map((tag) => tag.id) } },
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
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
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-happy' }).props.onPress());

        expect(renderer.root.findByProps({ testID: 'sidebar-list-name-input' }).props.value).toBe('Happy');
        expect(renderer.root.findAllByType('PickerContent').length).toBeGreaterThan(0);
        expect(renderer.root.findByProps({ testID: 'sidebar-list-directory-picker' }).findByType('PathPickerContent').props).toMatchObject({
            machineId: 'mac',
            manualInput: false,
        });
        expect(renderer.root.findByProps({ testID: 'sidebar-delete-list' }).props).toMatchObject({
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
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-create-list-button' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-name-input' }).props.onChangeText('Remote project'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-machine-picker' }).findByType('PickerContent').props.onSelect('mac'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-directory-picker' }).findByType('PathPickerContent').props.onChangeValue('/Users/test/project'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-create-list-submit' }).props.onPress());

        const create = mocks.updateOrganization.mock.calls.at(-1)?.[0];
        const created = create({ folders: [], lists: [], tags: [], sessions: {} });
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
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-happy' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-name-input' }).props.onChangeText('Happy renamed'));
        act(() => renderer.root.findByProps({ testID: 'sidebar-edit-list-submit' }).props.onPress());

        const rename = mocks.updateOrganization.mock.calls.at(-1)?.[0];
        const current = {
            folders: [],
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
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity />); });
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

    it('uses organization then sessions as two mobile drawer steps with a working back action', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity={false} />); });

        expect(renderer.root.findAllByProps({ testID: 'sidebar-organization-pane' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-session-pane' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'sidebar-list-happy' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-organization-pane' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-session-pane' })).toHaveLength(1);
        act(() => renderer.root.findByProps({ testID: 'sidebar-session-pane-back' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-organization-pane' })).toHaveLength(1);
        act(() => renderer.unmount());
    });

    it('expands folders and renders the Tag visibility controls as a mobile sheet', () => {
        mocks.organization = {
            ...mocks.organization,
            folders: [{ id: 'work', name: 'Work', createdAt: 1 }],
            lists: mocks.organization.lists.map((list: any) => ({ ...list, folderId: 'work' })),
        };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSidebarSessionsNavigation desktopDensity={false} />); });

        expect(renderer.root.findAllByProps({ testID: 'sidebar-list-happy' }).length).toBeGreaterThan(0);
        act(() => renderer.root.findByProps({ testID: 'sidebar-folder-work' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-list-happy' })).toHaveLength(0);

        act(() => renderer.root.findByProps({ testID: 'sidebar-tags-visibility-button' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-tags-visibility-sheet' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'sidebar-tags-visibility-when-populated' }).props.accessibilityState)
            .toEqual({ checked: true });
        act(() => renderer.root.findByProps({ testID: 'sidebar-tags-visibility-hidden' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-tags-visibility-sheet' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

});
