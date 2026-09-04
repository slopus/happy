import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarNavigator } from './SidebarNavigator';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    isTablet: true,
    clearSelection: vi.fn(),
    setZenMode: vi.fn(),
    setDesktopLeftSidebarCollapsed: vi.fn(),
    zenMode: false,
    desktopLeftSidebarCollapsed: false,
    pathname: '/',
}));

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock('@/utils/responsive', () => ({
    useIsTablet: () => mocks.isTablet,
    useHeaderHeight: () => 48,
}));
vi.mock('./SidebarView', () => ({ SidebarView: 'SidebarView' }));
vi.mock('expo-router/drawer', () => ({ Drawer: 'Drawer' }));
vi.mock('expo-router', () => ({
    useRouter: () => ({
        back: vi.fn(),
        canGoBack: () => false,
    }),
    usePathname: () => mocks.pathname,
}));
vi.mock('react-native', async () => {
    return {
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        Platform: { OS: 'web' },
        BackHandler: { addEventListener: vi.fn() },
        useWindowDimensions: () => ({ width: 1200, height: 800 }),
    };
});
vi.mock('@/sync/storage', () => ({
    useLocalSetting: (key: string) => key === 'zenMode'
        ? mocks.zenMode
        : key === 'desktopLeftSidebarCollapsed'
            ? mocks.desktopLeftSidebarCollapsed
            : false,
    useLocalSettingMutable: (key: string) => key === 'zenMode'
        ? [mocks.zenMode, mocks.setZenMode]
        : [mocks.desktopLeftSidebarCollapsed, mocks.setDesktopLeftSidebarCollapsed],
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                surfacePressed: '#222',
                divider: '#333',
                header: { tint: '#fff' },
                textLink: '#88f',
                status: { connected: '#34a853' },
                text: '#fff',
                textSecondary: '#aaa',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                surface: '#111',
                surfacePressed: '#222',
                divider: '#333',
                header: { tint: '#fff' },
                textLink: '#88f',
                status: { connected: '#34a853' },
            },
        }),
    },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('@/-session/sessionOverlayNav', () => {
    const useOverlayNav = Object.assign(
        (selector: (state: { canBack: boolean; canForward: boolean }) => unknown) => selector({
            canBack: false,
            canForward: false,
        }),
        {
            getState: () => ({
                back: () => false,
                forward: () => false,
            }),
        },
    );
    return { useOverlayNav };
});
vi.mock('@/hooks/useTauriZoom', () => ({ DEFAULT_APP_ZOOM: 1 }));
vi.mock('@/navigation/browserNavigation', () => ({
    canRouteForward: () => false,
    canUseRouteBack: () => false,
    getNavigatorCanGoBack: () => false,
}));
vi.mock('@/navigation/browserNavigationStore', () => {
    const state = {
        routeHistory: null,
        markRouteBack: vi.fn(),
        markRouteForward: vi.fn(),
    };
    const useBrowserNavigationStore = Object.assign(
        (selector: (value: typeof state) => unknown) => selector(state),
        { getState: () => state },
    );
    return { useBrowserNavigationStore };
});
vi.mock('@/hooks/useSessionSelection', () => ({
    useSessionSelection: (
        selector: (state: { active: boolean; clearSelection: () => void }) => unknown,
    ) => selector({ active: false, clearSelection: mocks.clearSelection }),
}));
vi.mock('./KeyboardShortcuts', () => ({
    KeyboardShortcutsProvider: ({ children }: { children: React.ReactNode }) => (
        React.createElement('KeyboardShortcutsProvider', null, children)
    ),
}));
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({
    DesktopWorkspaceLayoutProvider: ({
        children,
        enabled,
    }: {
        children: React.ReactNode;
        enabled: boolean;
    }) => React.createElement('DesktopWorkspaceLayoutProvider', { enabled }, children),
    useDesktopWorkspaceLayout: () => ({
        enabled: mocks.isTablet,
        leftExpandedWidth: mocks.isTablet ? 360 : 0,
        leftVisible: mocks.isTablet && !mocks.zenMode && !mocks.desktopLeftSidebarCollapsed,
        leftMaximumWidth: 640,
        leftWidth: mocks.isTablet && !mocks.zenMode && !mocks.desktopLeftSidebarCollapsed ? 360 : 0,
        rightPanelAvailable: false,
        rightVisible: false,
        rightMaximumWidth: 0,
        rightWidth: 0,
        resizingSide: null,
        beginPanelResize: vi.fn(),
        continuePanelResize: vi.fn(),
        endPanelResize: vi.fn(),
        resizePanelBy: vi.fn(),
        toggleLeftSidebar: () => mocks.setDesktopLeftSidebarCollapsed(!mocks.desktopLeftSidebarCollapsed),
        toggleRightSidebar: vi.fn(),
    }),
}));

describe('SidebarNavigator drawer behavior', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.isTablet = true;
        mocks.zenMode = false;
        mocks.desktopLeftSidebarCollapsed = false;
        mocks.pathname = '/';
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('mounts the shortcuts launcher inside the desktop workspace layout around navigator content', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        const layout = renderer.root.findByType('DesktopWorkspaceLayoutProvider');
        const shortcuts = layout.findByType('KeyboardShortcutsProvider');
        expect(layout.props.enabled).toBe(true);
        expect(shortcuts.findByType('Drawer')).toBeDefined();

        act(() => renderer.unmount());
    });

    it.each([
        { isTablet: true, expected: false, layout: 'desktop' },
        { isTablet: false, expected: true, layout: 'phone' },
    ])('sets closeDrawerOnNavigate to $expected for $layout layout', ({ isTablet, expected }) => {
        mocks.isTablet = isTablet;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        const drawer = renderer.root.findByType('Drawer');
        const sidebar = drawer.props.drawerContent().props.children;
        expect(sidebar.props.closeDrawerOnNavigate).toBe(expected);
        expect(sidebar.props.desktopDensity).toBe(isTablet);
        expect(sidebar.props.desktopPrimaryNavigation).toBe(isTablet);
        act(() => renderer.unmount());
    });

    it('collapses the desktop sidebar without changing Zen mode', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        const drawer = renderer.root.findByType('Drawer');
        expect(drawer.props.screenOptions.drawerStyle.width).toBe(420);
        expect(renderer.root.findByProps({ testID: 'desktop-left-panel-resize-handle' }).props.style)
            .toContainEqual({ left: 415 });
        expect(renderer.root.findByProps({ testID: 'desktop-navigation-controls' }).parent.props.style.left).toBe(436);
        const sidebarToggle = renderer.root.findByProps({ testID: 'desktop-navigation-sidebar-button' });
        expect(sidebarToggle.props['aria-expanded']).toBe(true);
        expect(sidebarToggle.props.accessibilityState).toEqual({ expanded: true });
        expect(sidebarToggle.props.accessibilityLabel).toBe('desktopWorkspace.hideSessions');
        expect(sidebarToggle.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ height: 40 }));
        expect(sidebarToggle.findByType('Ionicons').props.name).toBe('folder-open-outline');

        act(() => sidebarToggle.props.onPress());
        expect(mocks.setDesktopLeftSidebarCollapsed).toHaveBeenCalledWith(true);
        expect(mocks.setZenMode).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('removes a collapsed desktop sidebar from layout and the accessibility tree', () => {
        mocks.desktopLeftSidebarCollapsed = true;
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        const drawer = renderer.root.findByType('Drawer');
        const drawerContent = drawer.props.drawerContent();
        expect(drawer.props.screenOptions.drawerStyle.width).toBe(0);
        expect(drawerContent.props['aria-hidden']).toBe(true);
        expect(drawerContent.props.accessibilityElementsHidden).toBe(true);
        expect(drawerContent.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(drawerContent.props.inert).toBe(true);
        expect(drawerContent.props.pointerEvents).toBeUndefined();
        expect(drawerContent.props.dataSet).toMatchObject({
            happyMotion: 'desktop-panel',
            happyMotionSide: 'left',
            happyMotionState: 'closed',
        });
        expect(drawerContent.props.style).toContainEqual(expect.objectContaining({ width: 420 }));
        expect(drawerContent.props.style).toContainEqual(expect.objectContaining({ pointerEvents: 'none' }));
        expect(drawerContent.props.style).not.toContainEqual({ display: 'none' });

        const sidebarToggle = renderer.root.findByProps({ testID: 'desktop-navigation-sidebar-button' });
        expect(sidebarToggle.props['aria-expanded']).toBe(false);
        expect(sidebarToggle.props.accessibilityLabel).toBe('desktopWorkspace.showSessions');

        act(() => renderer.unmount());
    });

    it('keeps the Zen leaf green without swapping to a resize icon', () => {
        mocks.zenMode = true;
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        const zenToggle = renderer.root.findByProps({ testID: 'desktop-navigation-zen-button' });
        expect(zenToggle.props['aria-selected']).toBe(true);
        expect(zenToggle.props.accessibilityState).toEqual({ selected: true });
        expect(zenToggle.findAllByType('Text')).toHaveLength(0);
        expect(zenToggle.findByType('Ionicons').props.name).toBe('leaf-outline');
        expect(zenToggle.findByType('Ionicons').props.color).toBe('#34a853');
        act(() => zenToggle.props.onFocus());
        expect(renderer.root.findByProps({ testID: 'desktop-navigation-zen-tooltip' })).toBeDefined();

        act(() => zenToggle.props.onPress());
        expect(mocks.setZenMode).toHaveBeenCalledWith(false);
        expect(mocks.setDesktopLeftSidebarCollapsed).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('does not couple persistent desktop navigation to settings routes', () => {
        mocks.pathname = '/settings';
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        expect(renderer.root.findAllByProps({ testID: 'desktop-navigation-controls' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'desktop-left-panel-resize-handle' })).toHaveLength(1);

        act(() => renderer.unmount());
    });
});
