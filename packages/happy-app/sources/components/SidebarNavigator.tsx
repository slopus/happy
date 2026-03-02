import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { Platform, View, useWindowDimensions } from 'react-native';
import { ResizableDivider } from './ResizableDivider';
import { isLearnMode } from '@/appMode';
import { LearnSidebarView } from '@/learn/components/LearnSidebarView';
import { useLearnFocusMode } from '@/learn/learnStorage';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_STORAGE_KEY = 'happy_sidebar_width';
const SIDEBAR_COLLAPSED_KEY = 'happy_sidebar_collapsed';

// Context for sidebar collapse toggle
const SidebarCollapseContext = React.createContext<{
    collapsed: boolean;
    toggle: () => void;
}>({ collapsed: false, toggle: () => {} });

export function useSidebarCollapse() {
    return React.useContext(SidebarCollapseContext);
}

export function useContentMaxWidth(): number | undefined {
    const { collapsed } = React.useContext(SidebarCollapseContext);
    if (!collapsed) return undefined;
    const { EXPANDED_MAX_WIDTH } = require('./layout');
    return EXPANDED_MAX_WIDTH;
}

function loadCollapsed(): boolean {
    if (Platform.OS !== 'web') return false;
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {}
    return false;
}

function loadSavedWidth(): number | null {
    if (Platform.OS !== 'web') return null;
    try {
        const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
        if (v) return parseInt(v, 10);
    } catch {}
    return null;
}

function saveWidth(w: number) {
    if (Platform.OS !== 'web') return;
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(w)); } catch {}
}

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const focusMode = useLearnFocusMode();
    const showPermanentDrawer = auth.isAuthenticated && isTablet && !(isLearnMode && focusMode);
    const { width: windowWidth } = useWindowDimensions();

    const defaultWidth = Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    const [sidebarWidth, setSidebarWidth] = React.useState(() => loadSavedWidth() || defaultWidth);
    const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => loadCollapsed());

    const toggleSidebar = React.useCallback(() => {
        setSidebarCollapsed(prev => {
            const next = !prev;
            if (Platform.OS === 'web') {
                try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch {}
            }
            return next;
        });
    }, []);

    const collapseContextValue = React.useMemo(() => ({
        collapsed: sidebarCollapsed && showPermanentDrawer,
        toggle: toggleSidebar,
    }), [sidebarCollapsed, showPermanentDrawer, toggleSidebar]);

    const drawerWidth = showPermanentDrawer && !sidebarCollapsed
        ? Math.min(Math.max(sidebarWidth, SIDEBAR_MIN), SIDEBAR_MAX)
        : showPermanentDrawer && sidebarCollapsed
        ? 0
        : 280;

    const handleResize = React.useCallback((delta: number) => {
        setSidebarWidth(prev => {
            const next = Math.min(Math.max(prev + delta, SIDEBAR_MIN), SIDEBAR_MAX);
            return next;
        });
    }, []);

    const handleResizeEnd = React.useCallback(() => {
        setSidebarWidth(prev => {
            saveWidth(prev);
            return prev;
        });
    }, []);

    const drawerNavigationOptions = React.useMemo(() => {
        if (!showPermanentDrawer || sidebarCollapsed) {
            return {
                lazy: false,
                headerShown: false,
                drawerType: 'front' as const,
                swipeEnabled: false,
                drawerStyle: {
                    width: 0,
                    display: 'none' as const,
                },
            };
        }

        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: 'transparent',
                borderRightWidth: 0,
                width: drawerWidth,
            },
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [showPermanentDrawer, sidebarCollapsed, drawerWidth]);

    const drawerContent = React.useCallback(
        () => (
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <View style={{ flex: 1 }}>
                    {isLearnMode ? <LearnSidebarView /> : <SidebarView />}
                </View>
                {Platform.OS === 'web' && (
                    <ResizableDivider onResize={handleResize} onResizeEnd={handleResizeEnd} />
                )}
            </View>
        ),
        [handleResize, handleResizeEnd]
    );

    return (
        <SidebarCollapseContext.Provider value={collapseContextValue}>
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <View style={{ flex: 1 }}>
                    <Drawer
                        screenOptions={drawerNavigationOptions}
                        drawerContent={showPermanentDrawer && !sidebarCollapsed ? drawerContent : undefined}
                    />
                </View>
            </View>
        </SidebarCollapseContext.Provider>
    );
});
