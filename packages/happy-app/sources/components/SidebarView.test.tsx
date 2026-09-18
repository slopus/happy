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
    openSettings: vi.fn(),
    openActivity: vi.fn(),
    setDesktopSidebarListMode: vi.fn(),
    setDesktopSidebarMode: vi.fn(),
    commandPaletteAvailable: false,
    settingsModalIsDesktop: false,
    pluginSurfaceViews: [{
        componentId: 'relationship-advisor-history',
        contribution: { title: { default: 'Relationship Advisor', translations: { 'zh-Hans': '狗头军师' } } },
        icon: 'chatbubbles-outline',
        path: '/relationship-advisor',
        pluginId: 'relationship-advisor',
        surface: 'left-sidebar',
        viewId: 'relationship-advisor.history',
    }],
    desktopSidebarListMode: 'timeline',
    desktopSidebarMode: 'projects',
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
    ScrollView: 'ScrollView',
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
                    status: { connected: '#0a6', error: '#f00' },
                },
            })
            : factory,
    },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/sync/storage', () => ({
    useRealtimeStatus: () => 'connected',
    useProfile: () => null,
    useLocalSetting: () => [],
    useLocalSettingMutable: (name: string) => name === 'desktopSidebarMode'
        ? [mocks.desktopSidebarMode, mocks.setDesktopSidebarMode]
        : name === 'desktopSidebarListMode'
            ? [mocks.desktopSidebarListMode, mocks.setDesktopSidebarListMode]
            : [[], vi.fn()],
    useLocalSettingUpdater: () => vi.fn(),
}));
vi.mock('@/sync/profile', () => ({ getDisplayName: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./useDrawerHaptics', () => ({ useDrawerHaptics: () => undefined }));
vi.mock('./DesktopSettingsModal', () => ({
    useDesktopSettingsModal: () => ({
        isDesktop: mocks.settingsModalIsDesktop,
        openSettings: mocks.openSettings,
        openActivity: mocks.openActivity,
    }),
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
vi.mock('./plugins/usePluginSurfaceViews', () => ({
    usePluginSurfaceViews: () => mocks.pluginSurfaceViews,
}));
vi.mock('./plugins/pluginText', () => ({
    resolvePluginText: (value: { default: string; translations?: Record<string, string> }) => (
        value.translations?.['zh-Hans'] ?? value.default
    ),
}));
vi.mock('./DesktopSidebarSessionsNavigation', () => ({
    DesktopSidebarSessionsNavigation: 'DesktopSidebarSessionsNavigation',
}));

describe('SidebarView Agent space exit', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.pathname = '/';
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
        mocks.settingsModalIsDesktop = false;
        mocks.desktopSidebarListMode = 'timeline';
        mocks.desktopSidebarMode = 'projects';
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('ignores a persisted Agent space and renders the regular mobile sidebar', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarView />);
        });

        expect(renderer.root.findAllByType('AgentSpaceWorkbench')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-new-session-button' }).length).toBeGreaterThan(0);
        expect(mocks.exitSpace).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('ignores a persisted Agent space and renders the regular desktop sidebar', () => {
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
            );
        });

        expect(renderer.root.findAllByType('AgentSpaceWorkbench')).toHaveLength(0);
        expect(renderer.root.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(mocks.exitSpace).not.toHaveBeenCalled();
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
        expect(renderer.root.findAllByType('SidebarAccountMenu')).toHaveLength(1);
        expect(renderer.root.findAllByType('SidebarHelpMenu')).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'sidebar-footer-menus' }).props.style).toContainEqual(
            expect.objectContaining({ flexDirection: 'row' }),
        );
        expect(renderer.root.findByProps({ testID: 'sidebar-account-menu-slot' }).props.style).toEqual(
            expect.objectContaining({ flex: 1 }),
        );
        expect(renderer.root.findAllByProps({ testID: 'sidebar-user-card' })).toHaveLength(0);
        expect(renderer.root.findAllByType('MainView')).toHaveLength(0);
        expect(renderer.root.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(1);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'agents.empty')).toBe(false);

        act(() => renderer.unmount());
    });

    it('uses the compact icon-only rail for mobile session navigation', () => {
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
        )).toBe(false);
        expect(renderer.root.findByProps({ testID: 'mobile-primary-navigation-column' }).props.style).toContainEqual(expect.objectContaining({ width: 56 }));
        expect(renderer.root.findAllByType('ScrollView')).toHaveLength(1);
        expect(renderer.root.findByType('SidebarAccountMenu').props.mobileRail).toBe(true);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(0);
        for (const entry of ['new-session', 'inbox', 'command-palette', 'plugins', 'session-list', 'archive', 'plugin-relationship-advisor']) {
            const button = renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === `sidebar-${entry}-button`);
            expect(button.findAllByType('Text')).toHaveLength(0);
            expect(button.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ height: 44, width: 44 }));
        }
        expect(renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).findByType('Ionicons').props.name).toBe('albums-outline');
        expect(renderer.root.findByProps({ testID: 'sidebar-archive-button' }).findByType('Ionicons').props.name).toBe('file-tray-stacked-outline');
        expect(renderer.root.findAllByProps({ testID: 'sidebar-my-agents-button' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-add-agent-button' })).toHaveLength(0);
        const mobileNewSession = renderer.root.findByProps({ testID: 'sidebar-new-session-button' });
        const mobileNewSessionGlyph = mobileNewSession.findByProps({ testID: 'sidebar-new-session-glyph' });
        expect(mobileNewSessionGlyph.props.style).toEqual(expect.objectContaining({
            backgroundColor: '#0a6',
            borderRadius: 5,
            height: 22,
            width: 22,
        }));
        expect(mobileNewSessionGlyph.findByType('Ionicons').props).toMatchObject({
            name: 'add',
            color: '#FFFFFF',
            size: 20,
        });
        const pluginsButton = renderer.root.findByProps({ testID: 'sidebar-plugins-button' });
        act(() => pluginsButton.props.onPress());
        expect(renderer.root.findByType('PluginMarketplaceModal').props.visible).toBe(true);
        expect(renderer.root.findByType('PluginMarketplaceModal').props.initialPluginId).toBeNull();

        act(() => renderer.unmount());
    });

    it('returns from advisor history without navigating away or unmounting session views', () => {
        mocks.spaceAgent = null;
        mocks.pathname = '/relationship-advisor';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate />); });
        const sessions = renderer.root.findByType('DesktopSidebarSessionsNavigation');
        expect(sessions.parent.props.accessibilityElementsHidden).toBe(true);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(1);
        act(() => renderer.root.findByProps({ testID: 'mobile-sidebar-back-to-sessions' }).props.onPress());
        expect(renderer.root.findByType('DesktopSidebarSessionsNavigation')).toBe(sessions);
        expect(sessions.parent.props.accessibilityElementsHidden).toBe(false);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(0);
        const plugin = renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === 'sidebar-plugin-relationship-advisor-button');
        expect(plugin.props.accessibilityState.selected).toBe(false);
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
        act(() => renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).props.onPress());
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('timeline');
        expect(mocks.navigate).not.toHaveBeenCalled();
        act(() => renderer.root.findByProps({ testID: 'mobile-sidebar-close' }).props.onPress());
        expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DRAWER' });
        act(() => renderer.unmount());
    });

    it('switches the mobile sidebar to the archived-session list without navigating away', () => {
        mocks.spaceAgent = null;
        mocks.pathname = '/session/current';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate />); });

        const archiveButton = renderer.root.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-archive-button')!;
        expect(archiveButton.props.accessibilityState).toEqual({ selected: false });
        act(() => archiveButton.props.onPress());

        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('archive');
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('labels the mobile archive surface and selects its rail destination', () => {
        mocks.spaceAgent = null;
        mocks.desktopSidebarMode = 'archive';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate />); });

        const archiveButton = renderer.root.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-archive-button')!;
        const sessionListButton = renderer.root.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-session-list-button')!;
        expect(archiveButton.props.accessibilityState).toEqual({ selected: true });
        expect(sessionListButton.props.accessibilityState).toEqual({ selected: false });
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'sessionHistory.archiveTitle')).toBe(true);
        act(() => renderer.unmount());
    });

    it('opens advisor history from the rail without closing the drawer or changing the current chat', () => {
        mocks.spaceAgent = null;
        mocks.pathname = '/session/current';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-plugin-relationship-advisor-button' }).props.onPress());
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(1);
        const plugin = renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === 'sidebar-plugin-relationship-advisor-button');
        expect(plugin.props.accessibilityState.selected).toBe(true);
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
        act(() => renderer.root.findByType('PluginLeftSidebarSlot').props.onNavigate('/relationship-advisor'));
        expect(mocks.navigate).toHaveBeenCalledWith('/relationship-advisor');
        act(() => renderer.unmount());
    });

    it('closes the mobile drawer before opening settings', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate />);
        });

        const accountMenu = renderer.root.findByType('SidebarAccountMenu');
        act(() => accountMenu.props.onOpenSettings());

        expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DRAWER' });
        expect(mocks.navigate).toHaveBeenCalledWith('/settings');
        expect(mocks.openSettings).not.toHaveBeenCalled();

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
        act(() => renderer.root.findByType('SidebarHelpMenu').props.onOpenChange(true));
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

        act(() => renderer.root.findByType('SidebarAccountMenu').props.onOpenChange(true));
        expect(renderer.root.findByType('SidebarAccountMenu').props.open).toBe(true);
        expect(renderer.root.findByType('SidebarHelpMenu').props.open).toBe(false);

        act(() => renderer.root.findByType('SidebarHelpMenu').props.onOpenChange(true));
        expect(renderer.root.findByType('SidebarAccountMenu').props.open).toBe(false);
        expect(renderer.root.findByType('SidebarHelpMenu').props.open).toBe(true);

        act(() => renderer.root.findByType('SidebarAccountMenu').props.onOpenChange(true));
        expect(renderer.root.findByType('SidebarAccountMenu').props.open).toBe(true);
        expect(renderer.root.findByType('SidebarHelpMenu').props.open).toBe(false);

        const dismissLayer = renderer.root.findByProps({ testID: 'sidebar-footer-menu-dismiss-layer' });
        act(() => dismissLayer.props.onPress());
        expect(renderer.root.findByType('SidebarAccountMenu').props.open).toBe(false);
        expect(renderer.root.findByType('SidebarHelpMenu').props.open).toBe(false);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-footer-menu-dismiss-layer' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('transfers final focus to the newly opened footer menu and restores on ordinary close', () => {
        mocks.spaceAgent = null;
        vi.useFakeTimers();
        let renderer: any;

        try {
            act(() => {
                renderer = TestRenderer.create(
                    <SidebarView closeDrawerOnNavigate={false} desktopDensity />,
                );
            });

            act(() => renderer.root.findByType('SidebarHelpMenu').props.onOpenChange(true));
            act(() => vi.runOnlyPendingTimers());
            mocks.focusHistory.length = 0;

            act(() => renderer.root.findByType('SidebarAccountMenu').props.onOpenChange(true));
            act(() => vi.runOnlyPendingTimers());
            expect(mocks.focusHistory).toEqual(['account-first-action']);

            mocks.focusHistory.length = 0;
            act(() => renderer.root.findByType('SidebarHelpMenu').props.onOpenChange(true));
            act(() => vi.runOnlyPendingTimers());
            expect(mocks.focusHistory).toEqual(['help-first-action']);

            mocks.focusHistory.length = 0;
            act(() => renderer.root.findByType('SidebarHelpMenu').props.onOpenChange(false));
            act(() => vi.runOnlyPendingTimers());
            expect(mocks.focusHistory).toEqual(['help-trigger']);
        } finally {
            if (renderer) {
                act(() => renderer.unmount());
            }
            vi.clearAllTimers();
            vi.useRealTimers();
        }
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

    it('shows only advisor history on its desktop route and restores sessions when leaving', () => {
        mocks.spaceAgent = null;
        mocks.pathname = '/relationship-advisor';
        let renderer: any;
        const renderSidebar = () => <SidebarView closeDrawerOnNavigate={false} desktopDensity desktopPrimaryNavigation />;
        act(() => { renderer = TestRenderer.create(renderSidebar()); });

        const secondary = renderer.root.findByProps({ testID: 'desktop-secondary-navigation-column' });
        expect(secondary.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(0);
        expect(secondary.findByType('PluginLeftSidebarSlot').props.fillAvailableSpace).toBe(true);
        act(() => renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).props.onPress());
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('timeline');
        expect(mocks.navigate).toHaveBeenCalledWith('/');

        mocks.pathname = '/session/ordinary-session';
        act(() => renderer.update(<SidebarView closeDrawerOnNavigate={false} desktopDensity desktopPrimaryNavigation key="ordinary" />));
        expect(renderer.root.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('renders separate session destinations, installed plugins, and a green new-session plus icon', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity desktopPrimaryNavigation />,
            );
        });

        const primaryColumn = renderer.root.findByProps({ testID: 'desktop-primary-navigation-column' });
        expect(primaryColumn.props.style).toEqual(expect.objectContaining({ width: 60, zIndex: 100 }));
        expect(primaryColumn.findAllByType('Pressable').map((node: any) => node.props.testID)).toEqual(expect.arrayContaining([
            'sidebar-new-session-button',
            'sidebar-inbox-button',
            'sidebar-command-palette-button',
            'sidebar-plugins-button',
            'sidebar-plugin-relationship-advisor-button',
            'sidebar-session-list-button',
            'sidebar-archive-button',
        ]));
        expect(primaryColumn.findAllByProps({ testID: 'sidebar-my-agents-button' })).toHaveLength(0);
        expect(primaryColumn.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(0);
        expect(primaryColumn.findAllByProps({ testID: 'desktop-navigation-rail' })).toHaveLength(1);
        expect(primaryColumn.findAllByProps({ testID: 'desktop-navigation-rail-tooltip-new-session' })).toHaveLength(0);

        const newSession = primaryColumn.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-new-session-button')!;
        expect(newSession).toBeDefined();
        expect(newSession.findAllByType('Text')).toHaveLength(0);
        const newSessionGlyph = newSession.findByProps({ testID: 'sidebar-new-session-glyph' });
        expect(newSessionGlyph.props.style).toEqual(expect.objectContaining({
            alignItems: 'center',
            backgroundColor: '#0a6',
            borderRadius: 5,
            height: 22,
            justifyContent: 'center',
            width: 22,
        }));
        expect(newSessionGlyph.findByType('Ionicons').props).toMatchObject({
            name: 'add',
            color: '#FFFFFF',
            size: 20,
        });
        act(() => newSession.props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('/new');
        act(() => newSession.props.onHoverIn());
        const tooltip = primaryColumn.findByProps({ testID: 'desktop-navigation-rail-tooltip-new-session' });
        expect(tooltip.props.style).toEqual(expect.objectContaining({ minWidth: 92 }));
        expect(tooltip.findByType('Text').props).toMatchObject({
            children: 'sidebar.newSession',
            numberOfLines: 1,
        });
        act(() => newSession.props.onHoverOut());
        expect(primaryColumn.findAllByProps({ testID: 'desktop-navigation-rail-tooltip-new-session' })).toHaveLength(0);

        const secondaryColumn = renderer.root.findByProps({ testID: 'desktop-secondary-navigation-column' });
        expect(secondaryColumn.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(secondaryColumn.findAllByProps({ testID: 'sidebar-my-agents-button' })).toHaveLength(0);

        expect(primaryColumn.findAllByProps({ testID: 'sidebar-add-agent-button' })).toHaveLength(0);

        const sessionListButton = primaryColumn.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-session-list-button')!;
        expect(sessionListButton.props.accessibilityState).toEqual({ selected: true });
        expect(sessionListButton.findByType('Ionicons').props.name).toBe('albums-outline');

        const archiveButton = primaryColumn.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-archive-button')!;
        act(() => archiveButton.props.onPress());
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('archive');

        act(() => primaryColumn.findByProps({
            testID: 'sidebar-plugin-relationship-advisor-button',
        }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('/relationship-advisor');

        act(() => renderer.unmount());
    });

    it('restores the last Projects / Lists / Timeline view when leaving the archive surface', () => {
        mocks.spaceAgent = null;
        mocks.desktopSidebarMode = 'archive';
        mocks.desktopSidebarListMode = 'timeline';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity desktopPrimaryNavigation />,
            );
        });

        const primaryColumn = renderer.root.findByProps({ testID: 'desktop-primary-navigation-column' });
        const archiveButton = primaryColumn.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-archive-button')!;
        expect(archiveButton.props.accessibilityState).toEqual({ selected: true });
        expect(archiveButton.findByType('Ionicons').props.name).toBe('file-tray-stacked-outline');

        const sessionListButton = primaryColumn.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-session-list-button')!;
        act(() => sessionListButton.props.onPress());
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('timeline');

        act(() => renderer.unmount());
    });
});
