vi.mock('./personal/PersonalAgentEntry', () => ({ PersonalAgentEntry: 'PersonalAgentEntry' }));
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarView } from './SidebarView';
import { appThemes } from '@/themePacks';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    theme: { colors: { groupped: { background: '#fff' }, divider: '#ddd', desktopSkin: {} } } as any,
    desktopSkin: 'default',
    desktopProjectLocation: null as string | null,
    accountFirstActionFocus: vi.fn(),
    accountTriggerFocus: vi.fn(),
    dispatch: vi.fn(),
    exitSpace: vi.fn(),
    focusHistory: [] as string[],
    helpFirstActionFocus: vi.fn(),
    helpTriggerFocus: vi.fn(),
    navigate: vi.fn(),
    pathname: '/',
    rootState: undefined as any,
    session: null as any,
    openCommandPalette: vi.fn(),
    openSettings: vi.fn(),
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
    leftVisible: false,
    leftPinned: false,
    toggleLeftSidebar: vi.fn(),
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
    Platform: { OS: 'web', select: (values: any) => values.web ?? values.default },
    Text: 'Text',
    View: 'View',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({ useDesktopWorkspaceLayout: () => ({ leftVisible: mocks.leftVisible, leftPinned: mocks.leftPinned, toggleLeftSidebar: mocks.toggleLeftSidebar }) }));
vi.mock('expo-router', () => ({
    useNavigation: () => ({ dispatch: mocks.dispatch }),
    useRouter: () => ({ navigate: mocks.navigate }),
    useGlobalSearchParams: () => ({}),
    usePathname: () => mocks.pathname,
    useRootNavigationState: () => mocks.rootState,
}));
vi.mock('@react-navigation/native', () => ({
    DrawerActions: { closeDrawer: () => ({ type: 'CLOSE_DRAWER' }) },
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: mocks.theme }),
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: any) => object)({
                colors: {
                    groupped: { background: '#fff' },
                    header: { background: '#fff' },
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
    useSession: () => mocks.session,
    useRealtimeStatus: () => 'connected',
    useProfile: () => null,
    useLocalSetting: (name: string) => name === 'desktopSkinId' ? mocks.desktopSkin : name === 'desktopProjectLocation' ? mocks.desktopProjectLocation : [],
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
    DesktopSidebarHeader: 'DesktopSidebarHeader',
}));

describe('SidebarView Agent space exit', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.pathname = '/';
        mocks.rootState = undefined;
        mocks.leftVisible = false;
        mocks.leftPinned = false;
        mocks.theme = appThemes.ginghamLight;
        mocks.desktopSkin = 'default';
        mocks.desktopProjectLocation = null;
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

    it('keeps the permanent rail on the live theme when appearance changes without remounting', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation />); });
        const style = (id: string) => Object.assign({}, ...renderer.root.findByProps({ testID: id }).props.style.flat().filter(Boolean));
        expect(style('desktop-primary-navigation-column').backgroundColor).toBe(appThemes.ginghamLight.colors.header.background);
        mocks.theme = appThemes.ginghamDark;
        act(() => { renderer.update(<SidebarView desktopDensity desktopPrimaryNavigation desktopSecondaryVisible={false} />); });
        expect(style('desktop-primary-navigation-column').backgroundColor).toBe(appThemes.ginghamDark.colors.header.background);
        expect(style('desktop-primary-navigation-column').borderRightColor).toBe(appThemes.ginghamDark.colors.divider);
        expect(style('sidebar-desktop-density').backgroundColor).toBe(appThemes.ginghamDark.colors.groupped.background);
        expect(style('desktop-secondary-navigation-column').backgroundColor).toBe(appThemes.ginghamDark.colors.groupped.background);
        mocks.desktopSkin = 'dreamskin';
        mocks.theme = appThemes.dreamskinDark;
        act(() => { renderer.update(<SidebarView desktopDensity desktopPrimaryNavigation desktopSecondaryVisible />); });
        expect(style('desktop-primary-navigation-column').backgroundColor).toBe(appThemes.dreamskinDark.colors.header.background);
        mocks.desktopSkin = 'firefly';
        mocks.theme = appThemes.fireflyLight;
        act(() => { renderer.update(<SidebarView desktopDensity desktopPrimaryNavigation desktopSecondaryVisible={false} />); });
        expect(style('desktop-primary-navigation-column').backgroundColor).toBe(appThemes.fireflyLight.colors.header.background);
        act(() => renderer.unmount());
    });

    it('preserves the opaque project sidebar and project selection under Settings', () => {
        mocks.spaceAgent = null;
        mocks.pathname = '/settings';
        mocks.rootState = { index: 1, desktopModalBaseKey: 'project', routes: [
            { key: 'project', name: 'projects' }, { key: 'settings', name: 'settings/index' },
        ] };
        mocks.desktopSkin = 'dreamskin';
        mocks.theme = appThemes.ginghamDark;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation desktopSecondaryVisible />); });
        const column = renderer.root.findByProps({ testID: 'desktop-secondary-navigation-column' });
        expect(Object.assign({}, ...column.props.style.flat().filter(Boolean)).backgroundColor).toBe(appThemes.ginghamDark.colors.desktopSkin.reducedSidebar);
        const project = renderer.root.findByProps({ testID: 'sidebar-project-goals-button' });
        expect(project.props.selected).toBe(true);
        act(() => renderer.unmount());
    });

    it('returns from another page to the remembered project and task path', () => {
        mocks.spaceAgent = null; mocks.pathname = '/session/another';
        mocks.desktopProjectLocation = '/projects?machine=mac&project=%2Fgoals%2Fcreative-web&feature=%2Fgoals%2Fcreative-web%2Ffeatures%2Fdesign-ops&task=task-4&conversation=chat-4';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-project-goals-button' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(mocks.desktopProjectLocation);
        act(() => renderer.unmount());
    });

    it('does not reset the current project when its rail entry is clicked again', () => {
        mocks.spaceAgent = null; mocks.pathname = '/projects';
        mocks.desktopProjectLocation = '/projects?machine=mac&feature=%2Fdesign-ops';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-project-goals-button' }).props.onPress());
        expect(mocks.navigate).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('opens all projects when there is no remembered project location', () => {
        mocks.spaceAgent = null; mocks.pathname = '/new';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-project-goals-button' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/projects');
        act(() => renderer.unmount());
    });

    it('keeps phone project entry independent of the remembered desktop path', () => {
        mocks.spaceAgent = null; mocks.pathname = '/session/phone';
        mocks.desktopProjectLocation = '/projects?machine=mac&feature=%2Fdesktop';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-project-goals-button' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/projects');
        act(() => renderer.unmount());
    });

    it.each([false, true])('returns from All projects to Home with sidebar visible: %s', visible => {
        mocks.pathname = '/projects'; mocks.spaceAgent = null;
        mocks.leftVisible = visible;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation desktopSecondaryVisible={visible} />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/');
        expect(mocks.toggleLeftSidebar).not.toHaveBeenCalled();
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('timeline');
        expect(mocks.setDesktopSidebarListMode).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

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
        for (const entry of ['new-session', 'command-palette', 'plugins', 'session-list', 'archive', 'plugin-relationship-advisor']) {
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

    it('keeps mobile project-page sidebar selection in the drawer', () => {
        mocks.pathname = '/projects'; mocks.spaceAgent = null;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).props.onPress());
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('timeline');
        expect(mocks.toggleLeftSidebar).not.toHaveBeenCalled();
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
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

    it('retains the mobile archive entry and switches its sidebar without navigation', () => {
        mocks.spaceAgent = null; mocks.pathname = '/session/current';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView closeDrawerOnNavigate />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-archive-button' }).props.onPress());
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('archive');
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('keeps an existing mobile archive selection', () => {
        mocks.spaceAgent = null; mocks.desktopSidebarMode = 'archive';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView />); });
        expect(mocks.setDesktopSidebarMode).not.toHaveBeenCalledWith('projects');
        expect(renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === 'sidebar-archive-button').props.accessibilityState).toEqual({ selected: true });
        act(() => renderer.unmount());
    });

    it('preserves the native tablet archive route', () => {
        mocks.spaceAgent = null; mocks.desktopSidebarMode = 'archive';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity />); });
        expect(mocks.setDesktopSidebarMode).not.toHaveBeenCalledWith('projects');
        act(() => renderer.root.findByProps({ testID: 'sidebar-archive-button' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('/session/recent');
        act(() => renderer.unmount());
    });

    it('migrates an old archive sidebar preference back to projects', () => {
        mocks.desktopSidebarMode = 'archive';
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation />); });
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('projects');
        expect(renderer.root.findAllByProps({ testID: 'sidebar-archive-button' })).toHaveLength(0);
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
        const header = secondary.findByType('DesktopSidebarHeader');
        act(() => header.props.onModeChange('lists'));
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('lists');
        act(() => header.props.onSearch());
        expect(mocks.navigate).toHaveBeenCalledWith('/session/search');
        act(() => renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).props.onPress());
        expect(mocks.setDesktopSidebarMode).toHaveBeenLastCalledWith('timeline');
        expect(mocks.navigate).toHaveBeenCalledWith('/');

        mocks.pathname = '/session/ordinary-session';
        act(() => renderer.update(<SidebarView closeDrawerOnNavigate={false} desktopDensity desktopPrimaryNavigation key="ordinary" />));
        expect(renderer.root.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(renderer.root.findAllByType('PluginLeftSidebarSlot')).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps desktop rail destinations without duplicating new session or search', () => {
        mocks.spaceAgent = null;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(
                <SidebarView closeDrawerOnNavigate={false} desktopDensity desktopPrimaryNavigation />,
            );
        });

        const primaryColumn = renderer.root.findByProps({ testID: 'desktop-primary-navigation-column' });
        const primaryColumnStyle = Object.assign({}, ...[primaryColumn.props.style].flat(Infinity));
        expect(primaryColumnStyle).toEqual(expect.objectContaining({ width: 60, zIndex: 100 }));
        expect(primaryColumn.findAllByType('Pressable').map((node: any) => node.props.testID)).toEqual(expect.arrayContaining([
            'sidebar-plugins-button',
            'sidebar-plugin-relationship-advisor-button',
            'sidebar-session-list-button',
        ]));
        expect(primaryColumn.findAllByProps({ testID: 'sidebar-my-agents-button' })).toHaveLength(0);
        expect(primaryColumn.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(0);
        expect(primaryColumn.findAllByProps({ testID: 'desktop-navigation-rail' })).toHaveLength(1);
        expect(primaryColumn.findAllByProps({ testID: 'sidebar-new-session-button' })).toHaveLength(0);
        expect(primaryColumn.findAllByProps({ testID: 'sidebar-command-palette-button' })).toHaveLength(0);

        const secondaryColumn = renderer.root.findByProps({ testID: 'desktop-secondary-navigation-column' });
        expect(secondaryColumn.findAllByType('DesktopSidebarSessionsNavigation')).toHaveLength(1);
        expect(secondaryColumn.findAllByProps({ testID: 'sidebar-my-agents-button' })).toHaveLength(0);

        expect(primaryColumn.findAllByProps({ testID: 'sidebar-add-agent-button' })).toHaveLength(0);

        const sessionListButton = primaryColumn.findAllByType('Pressable')
            .find((node: any) => node.props.testID === 'sidebar-session-list-button')!;
        expect(sessionListButton.props.accessibilityState).toEqual({ selected: true });
        expect(sessionListButton.findByType('Ionicons').props.name).toBe('home-outline');

        expect(primaryColumn.findAllByProps({ testID: 'sidebar-archive-button' })).toHaveLength(0);

        act(() => primaryColumn.findByProps({
            testID: 'sidebar-plugin-relationship-advisor-button',
        }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('/relationship-advisor');

        act(() => renderer.unmount());
    });

    it.each([false, true])('highlights only All projects on the project page with sidebar visible: %s', visible => {
        mocks.spaceAgent = null; mocks.pathname = '/projects'; mocks.leftVisible = visible;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation desktopSecondaryVisible={visible} />); });
        const pressable = (id: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === id);
        expect(pressable('sidebar-session-list-button').props.accessibilityState).toEqual({ selected: false });
        expect(pressable('sidebar-project-goals-button').props.accessibilityState).toEqual({ selected: true });
        act(() => renderer.unmount());
    });

    it('opens a collapsed session sidebar from the desktop home button without resetting its view', () => {
        mocks.pathname = '/session/example';
        mocks.leftVisible = true; // Hover-revealed but not pinned.
        mocks.leftPinned = false;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation />); });
        act(() => renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).props.onPress());
        expect(mocks.toggleLeftSidebar).toHaveBeenCalledOnce();
        expect(mocks.setDesktopSidebarMode).toHaveBeenCalledWith('timeline');
        expect(mocks.setDesktopSidebarListMode).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it.each(['projects', 'lists', 'timeline'])('restores the saved %s view across desktop destinations and sidebar remounts', mode => {
        mocks.spaceAgent = null;
        mocks.desktopSidebarListMode = mode;

        for (const pathname of ['/projects', '/relationship-advisor', '/session/example', '/']) {
            for (const pinned of [false, true]) {
                vi.clearAllMocks();
                mocks.pathname = pathname;
                mocks.leftPinned = pinned;
                let renderer: any;
                act(() => { renderer = TestRenderer.create(<SidebarView desktopDensity desktopPrimaryNavigation />); });
                act(() => renderer.root.findByProps({ testID: 'sidebar-session-list-button' }).props.onPress());

                expect(mocks.setDesktopSidebarMode).toHaveBeenCalledExactlyOnceWith(mode);
                expect(mocks.setDesktopSidebarListMode).not.toHaveBeenCalled();
                expect(mocks.desktopSidebarListMode).toBe(mode);
                if (pathname === '/projects' || pathname === '/relationship-advisor') {
                    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/');
                } else {
                    expect(mocks.navigate).not.toHaveBeenCalled();
                }
                expect(mocks.toggleLeftSidebar).toHaveBeenCalledTimes(pathname !== '/projects' && !pinned ? 1 : 0);
                act(() => renderer.unmount());
            }
        }
    });


});
