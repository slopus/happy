import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarView } from './SidebarView';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    accountFirstActionFocus: vi.fn(),
    accountTriggerFocus: vi.fn(),
    dispatch: vi.fn(),
    exitSpace: vi.fn(),
    focusHistory: [] as string[],
    helpFirstActionFocus: vi.fn(),
    helpTriggerFocus: vi.fn(),
    navigate: vi.fn(),
    pathname: '/',
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
    useGlobalSearchParams: () => ({}),
    usePathname: () => mocks.pathname,
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
    useLocalSettingMutable: () => [[], vi.fn()],
    useLocalSettingUpdater: () => vi.fn(),
}));
vi.mock('@/sync/profile', () => ({ getDisplayName: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./useDrawerHaptics', () => ({ useDrawerHaptics: () => undefined }));
vi.mock('./DesktopSettingsModal', () => ({
    useDesktopSettingsModal: () => ({ openSettings: vi.fn() }),
}));
vi.mock('./VoiceAssistantStatusBar', () => ({ VoiceAssistantStatusBar: 'VoiceAssistantStatusBar' }));
vi.mock('./MainView', () => ({ MainView: 'MainView' }));
vi.mock('./SidebarAccountMenu', async () => {
    const ReactModule = await import('react');
    return {
        SidebarAccountMenu: (props: any) => {
            const wasOpenRef = ReactModule.useRef(false);
            ReactModule.useEffect(() => {
                const wasOpen = wasOpenRef.current;
                wasOpenRef.current = props.open;
                const timeout = setTimeout(() => {
                    if (props.open) {
                        mocks.focusHistory.push('account-first-action');
                        mocks.accountFirstActionFocus();
                    } else if (wasOpen && props.restoreFocusOnClose !== false) {
                        mocks.focusHistory.push('account-trigger');
                        mocks.accountTriggerFocus();
                    }
                }, 0);
                return () => clearTimeout(timeout);
            }, [props.open, props.restoreFocusOnClose]);
            return ReactModule.createElement('SidebarAccountMenu', props);
        },
    };
});
vi.mock('./SidebarHelpMenu', async () => {
    const ReactModule = await import('react');
    return {
        SidebarHelpMenu: (props: any) => {
            const wasOpenRef = ReactModule.useRef(false);
            ReactModule.useEffect(() => {
                const wasOpen = wasOpenRef.current;
                wasOpenRef.current = props.open;
                const timeout = setTimeout(() => {
                    if (props.open) {
                        mocks.focusHistory.push('help-first-action');
                        mocks.helpFirstActionFocus();
                    } else if (wasOpen && props.restoreFocusOnClose !== false) {
                        mocks.focusHistory.push('help-trigger');
                        mocks.helpTriggerFocus();
                    }
                }, 0);
                return () => clearTimeout(timeout);
            }, [props.open, props.restoreFocusOnClose]);
            return ReactModule.createElement('SidebarHelpMenu', props);
        },
    };
});
vi.mock('./agents/AgentSheet', () => ({ AgentSheet: 'AgentSheet' }));
vi.mock('./plugins/PluginMarketplaceModal', () => ({ PluginMarketplaceModal: 'PluginMarketplaceModal' }));
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
vi.mock('./plugins/PluginLeftSidebarSlot', () => ({
    PluginLeftSidebarSlot: 'PluginLeftSidebarSlot',
}));
vi.mock('./DesktopSidebarSessionsNavigation', () => ({
    DesktopSidebarSessionsNavigation: 'DesktopSidebarSessionsNavigation',
}));
vi.mock('./DesktopSidebarIconRail', () => ({ DesktopSidebarIconRail: 'DesktopSidebarIconRail' }));

describe('SidebarView Agent space exit', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.focusHistory.length = 0;
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
        mocks.pathname = '/';
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
        expect(renderer.root.findAllByType('DesktopSidebarIconRail')).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-user-card' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MainView')).toHaveLength(0);
        expect(renderer.root.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(renderer.root.findByType('DesktopSidebarSessionsNavigation').props.desktopDensity).toBe(true);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(0);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'agents.empty')).toBe(false);

        act(() => renderer.unmount());
    });

    it('replaces the global library with the installed plugin conversation index on its route', () => {
        mocks.spaceAgent = null;
        mocks.pathname = '/relationship-advisor';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
            );
        });

        expect(renderer.root.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(0);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(1);
        expect(renderer.root.findByType('PluginLeftSidebarSlot').props).toMatchObject({
            desktopDensity: true,
            fill: true,
        });

        act(() => renderer.unmount());
    });

    it('keeps the roomier mobile sidebar layout and exposes Projects / Lists organization', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'sidebar-desktop-density' })).toHaveLength(0);
        expect(renderer.root.findByType('SidebarAccountMenu').props.desktopDensity).toBe(false);
        expect(renderer.root.findAllByType('SidebarHelpMenu')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-user-card' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MainView')).toHaveLength(0);
        expect(renderer.root.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(renderer.root.findAllByType('Text').some(
            (node: any) => node.props.children === 'agents.empty',
        )).toBe(true);
        const secondary = renderer.root.findByProps({ testID: 'sidebar-secondary-navigation' });
        expect(secondary.props.style).not.toHaveProperty('marginHorizontal');
        expect(secondary.findByProps({ testID: 'sidebar-secondary-navigation-divider' }).props.style).toEqual(
            expect.objectContaining({ marginHorizontal: 10 }),
        );
        expect(
            secondary.findByProps({ testID: 'sidebar-my-agents-button' }).props.style({ pressed: false }),
        ).toContainEqual(expect.objectContaining({ marginHorizontal: 16 }));
        expect(renderer.root.findByType('AgentSheet').props.visible).toBe(false);
        act(() => secondary.findByProps({ testID: 'sidebar-my-agents-button' }).props.onPress());
        expect(renderer.root.findByType('AgentSheet').props.visible).toBe(true);
        expect(mocks.navigate).not.toHaveBeenCalledWith('/settings/my-agents');

        const pluginsButton = renderer.root.findByProps({ testID: 'sidebar-plugins-button' });
        act(() => pluginsButton.props.onPress());
        expect(renderer.root.findByType('PluginMarketplaceModal').props.visible).toBe(true);
        expect(renderer.root.findByType('PluginMarketplaceModal').props.initialPluginId).toBeNull();

        act(() => renderer.unmount());
    });

    it('clears an open Help footer layer when desktop density turns off', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
            );
        });
        act(() => renderer.root.findByType('DesktopSidebarIconRail').props.onFooterMenuChange('help'));
        expect(renderer.root.findAllByProps({ testID: 'sidebar-footer-menu-dismiss-layer' })).toHaveLength(1);

        act(() => renderer.update(
            <SidebarView closeDrawerOnNavigate={false} desktopDensity={false} />,
        ));

        expect(renderer.root.findAllByType('SidebarHelpMenu')).toHaveLength(0);
        expect(renderer.root.findByType('SidebarAccountMenu').props.open).toBe(false);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-footer-menu-dismiss-layer' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('keeps the desktop footer menus mutually exclusive and dismisses either from one layer', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
            );
        });

        act(() => renderer.root.findByType('DesktopSidebarIconRail').props.onFooterMenuChange('account'));
        expect(renderer.root.findByType('DesktopSidebarIconRail').props.footerMenu).toBe('account');

        act(() => renderer.root.findByType('DesktopSidebarIconRail').props.onFooterMenuChange('help'));
        expect(renderer.root.findByType('DesktopSidebarIconRail').props.footerMenu).toBe('help');

        act(() => renderer.root.findByType('DesktopSidebarIconRail').props.onFooterMenuChange('account'));
        expect(renderer.root.findByType('DesktopSidebarIconRail').props.footerMenu).toBe('account');

        const dismissLayer = renderer.root.findByProps({ testID: 'sidebar-footer-menu-dismiss-layer' });
        act(() => dismissLayer.props.onPress());
        expect(renderer.root.findByType('DesktopSidebarIconRail').props.footerMenu).toBeNull();
        expect(renderer.root.findAllByProps({ testID: 'sidebar-footer-menu-dismiss-layer' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('keeps one controlled footer menu state while switching rail layers', () => {
        mocks.spaceAgent = null;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate={false} desktopDensity />); });
        const rail = () => renderer.root.findByType('DesktopSidebarIconRail');
        act(() => rail().props.onFooterMenuChange('account'));
        expect(rail().props.footerMenu).toBe('account');
        act(() => rail().props.onFooterMenuChange('help'));
        expect(rail().props.footerMenu).toBe('help');
        act(() => rail().props.onFooterMenuChange(null));
        expect(rail().props.footerMenu).toBeNull();
        act(() => renderer.unmount());
    });

    it('opens the shared command palette from desktop Search without routing away', () => {
        mocks.spaceAgent = null;
        mocks.commandPaletteAvailable = true;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate={false} desktopDensity />);
        });

        act(() => renderer.root.findByType('DesktopSidebarIconRail').props.onOpenSessionSearch());

        expect(mocks.openCommandPalette).toHaveBeenCalledOnce();
        expect(mocks.navigate).not.toHaveBeenCalledWith('/session/search');

        act(() => renderer.unmount());
    });

    it('routes desktop global actions through the dedicated icon rail', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
            );
        });

        const rail = renderer.root.findByType('DesktopSidebarIconRail');
        expect(rail.props).toMatchObject({
            onNavigate: expect.any(Function),
            onOpenAgents: expect.any(Function),
            onOpenPluginMarketplace: expect.any(Function),
            onOpenSessionSearch: expect.any(Function),
            onOpenSettings: expect.any(Function),
        });
        expect(renderer.root.findAllByProps({ testID: 'sidebar-primary-navigation' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-secondary-navigation' })).toHaveLength(0);

        act(() => renderer.unmount());
    });
});
