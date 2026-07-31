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
                text: '#fff',
                textSecondary: '#aaa',
            },
        },
    }),
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

describe('SidebarNavigator drawer behavior', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.isTablet = true;
        mocks.zenMode = false;
        mocks.desktopLeftSidebarCollapsed = false;
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

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
        const sidebar = drawer.props.drawerContent();
        expect(sidebar.props.closeDrawerOnNavigate).toBe(expected);
        expect(sidebar.props.desktopDensity).toBe(isTablet);
        act(() => renderer.unmount());
    });

    it('collapses the desktop sidebar without changing Zen mode', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        const drawer = renderer.root.findByType('Drawer');
        expect(drawer.props.screenOptions.drawerStyle.width).toBe(360);
        const sidebarToggle = renderer.root.findByProps({ testID: 'desktop-navigation-sidebar-button' });
        expect(sidebarToggle.props.accessibilityState).toEqual({ expanded: true });

        act(() => sidebarToggle.props.onPress());
        expect(mocks.setDesktopLeftSidebarCollapsed).toHaveBeenCalledWith(true);
        expect(mocks.setZenMode).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('keeps a visible labeled and selected Zen exit affordance', () => {
        mocks.zenMode = true;
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SidebarNavigator />);
        });

        const zenToggle = renderer.root.findByProps({ testID: 'desktop-navigation-zen-button' });
        expect(zenToggle.props.accessibilityState).toEqual({ selected: true });
        expect(zenToggle.findAllByType('Text').some((node: any) => node.props.children === 'zen.toggle')).toBe(true);
        expect(zenToggle.findAllByType('Ionicons').some((node: any) => node.props.name === 'close-circle')).toBe(true);

        act(() => zenToggle.props.onPress());
        expect(mocks.setZenMode).toHaveBeenCalledWith(false);
        expect(mocks.setDesktopLeftSidebarCollapsed).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });
});
