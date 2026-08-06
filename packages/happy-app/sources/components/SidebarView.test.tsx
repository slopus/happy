import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarView } from './SidebarView';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    dispatch: vi.fn(),
    exitSpace: vi.fn(),
    navigate: vi.fn(),
    openCommandPalette: vi.fn(),
    commandPaletteAvailable: false,
    spaceAgent: {
        id: 'health',
        name: 'Health',
        glyph: 'H',
        color: '#00aa66',
        machineId: 'machine-1',
        path: '~/health',
        kind: 'standard',
        spaceType: 'health',
        imageStyleIds: [],
        imageVariantsPerStyle: 1,
        presets: [],
    } as any,
}));

vi.mock('react-native', () => ({
    Text: 'Text',
    View: 'View',
    Pressable: 'Pressable',
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('expo-router', () => ({
    useNavigation: () => ({ dispatch: mocks.dispatch }),
    useRouter: () => ({ navigate: mocks.navigate }),
}));
vi.mock('@react-navigation/native', () => ({
    DrawerActions: { closeDrawer: () => ({ type: 'CLOSE_DRAWER' }) },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: any) => object)({
                colors: {
                    groupped: { background: '#fff' },
                    surface: '#fff',
                    surfacePressed: '#eee',
                    divider: '#ddd',
                    text: '#111',
                    textSecondary: '#666',
                    status: { error: '#f00' },
                },
            })
            : factory,
    },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/sync/storage', () => ({
    useRealtimeStatus: () => 'connected',
    useFriendRequests: () => [],
    useProfile: () => null,
    useLocalSetting: () => [],
}));
vi.mock('@/sync/profile', () => ({ getDisplayName: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./useDrawerHaptics', () => ({ useDrawerHaptics: () => undefined }));
vi.mock('./VoiceAssistantStatusBar', () => ({ VoiceAssistantStatusBar: 'VoiceAssistantStatusBar' }));
vi.mock('./MainView', () => ({ MainView: 'MainView' }));
vi.mock('./SidebarAccountMenu', () => ({ SidebarAccountMenu: 'SidebarAccountMenu' }));
vi.mock('./agents/AgentSheet', () => ({ AgentSheet: 'AgentSheet' }));
vi.mock('@/hooks/useAgentSpace', () => ({
    useAgentSpace: () => ({
        agent: mocks.spaceAgent,
        exit: mocks.exitSpace,
    }),
}));
vi.mock('./agents/AgentSpaceWorkbench', () => ({ AgentSpaceWorkbench: 'AgentSpaceWorkbench' }));
vi.mock('./CommandPalette/CommandPaletteProvider', () => ({
    useCommandPaletteLauncher: () => ({
        isAvailable: mocks.commandPaletteAvailable,
        open: mocks.openCommandPalette,
    }),
}));

describe('SidebarView Agent space exit', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.spaceAgent = {
            id: 'health',
            name: 'Health',
            glyph: 'H',
            color: '#00aa66',
            machineId: 'machine-1',
            path: '~/health',
            kind: 'standard',
            spaceType: 'health',
            imageStyleIds: [],
            imageVariantsPerStyle: 1,
            presets: [],
        };
        mocks.commandPaletteAvailable = false;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('clears the Agent space, closes the drawer, and returns home', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarView />);
        });

        const workbench = renderer.root.findByType('AgentSpaceWorkbench');
        act(() => workbench.props.onExit());

        expect(mocks.exitSpace).toHaveBeenCalledOnce();
        expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DRAWER' });
        expect(mocks.navigate).toHaveBeenCalledWith('/');
        act(() => renderer.unmount());
    });

    it('does not close a permanent desktop drawer before navigation', () => {
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} />,
            );
        });

        const workbench = renderer.root.findByType('AgentSpaceWorkbench');
        act(() => workbench.props.onExit());

        expect(mocks.exitSpace).toHaveBeenCalledOnce();
        expect(mocks.dispatch).not.toHaveBeenCalled();
        expect(mocks.navigate).toHaveBeenCalledWith('/');
        act(() => renderer.unmount());
    });

    it('uses a compact desktop-only density and keeps the session list visible', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'sidebar-desktop-density' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'sidebar-desktop-density' }).props.style).toContainEqual(
            expect.objectContaining({ borderWidth: 0 }),
        );
        expect(renderer.root.findByType('SidebarAccountMenu').props.desktopDensity).toBe(true);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-user-card' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MainView')).toHaveLength(1);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'agents.empty')).toBe(false);

        act(() => renderer.unmount());
    });

    it('keeps the roomier mobile sidebar layout unchanged', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'sidebar-desktop-density' })).toHaveLength(0);
        expect(renderer.root.findByType('SidebarAccountMenu').props.desktopDensity).toBe(false);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-user-card' })).toHaveLength(0);
        expect(renderer.root.findAllByType('Text').some(
            (node: any) => node.props.children === 'agents.empty',
        )).toBe(true);

        act(() => renderer.unmount());
    });

    it('opens the shared command palette from desktop Search without routing away', () => {
        mocks.spaceAgent = null;
        mocks.commandPaletteAvailable = true;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate={false} desktopDensity />);
        });

        const searchButton = renderer.root.findByProps({ testID: 'sidebar-command-palette-button' });
        act(() => searchButton.props.onPress());

        expect(mocks.openCommandPalette).toHaveBeenCalledOnce();
        expect(mocks.navigate).not.toHaveBeenCalledWith('/session/search');

        act(() => renderer.unmount());
    });

    it('keeps primary work destinations contiguous and Agents secondary', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
            );
        });

        const primary = renderer.root.findByProps({ testID: 'sidebar-primary-navigation' });
        expect(primary.findAllByType('Pressable').map((node: any) => node.props.testID)).toEqual([
            'sidebar-new-session-button',
            'sidebar-inbox-button',
            'sidebar-command-palette-button',
        ]);
        expect(primary.findAllByProps({ testID: 'sidebar-my-agents-button' })).toHaveLength(0);

        const secondary = renderer.root.findByProps({ testID: 'sidebar-secondary-navigation' });
        expect(secondary.findAllByProps({ testID: 'sidebar-my-agents-button' })).toHaveLength(1);
        const addAgent = secondary.findByProps({ testID: 'sidebar-add-agent-button' });
        expect(addAgent.props.accessibilityLabel).toBe('agents.add');
        expect(addAgent.findAllByType('Text')).toHaveLength(0);

        act(() => renderer.unmount());
    });
});
