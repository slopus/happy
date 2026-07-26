import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { useWindowDimensions, View, Pressable, Platform, BackHandler } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { canRouteBack, canRouteForward, canUseRouteBack, getNavigatorCanGoBack } from '@/navigation/browserNavigation';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { useSessionSelection } from '@/hooks/useSessionSelection';
import {
    getDesktopSidebarWidth,
    getPersistentHeaderPointerEvents,
    TAURI_HEADER_CONTROL_LEFT,
} from '@/utils/desktopNavigationLayout';

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const { theme } = useUnistyles();
    const zenMode = useLocalSetting('zenMode');
    const selectionMode = useSessionSelection((s) => s.active);
    const clearSelection = useSessionSelection((s) => s.clearSelection);
    const isDesktopLayout = auth.isAuthenticated && isTablet;
    const showSidebar = isDesktopLayout && !zenMode;
    const { width: windowWidth } = useWindowDimensions();

    // Calculate target drawer width
    const fullDrawerWidth = React.useMemo(() => {
        if (!isDesktopLayout) return 320;
        return getDesktopSidebarWidth(windowWidth);
    }, [windowWidth, isDesktopLayout]);
    const drawerWidth = showSidebar ? fullDrawerWidth : 0;

    React.useEffect(() => {
        if (!selectionMode || Platform.OS === 'web') {
            return;
        }

        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            clearSelection();
            return true;
        });

        return () => subscription.remove();
    }, [clearSelection, selectionMode]);

    const drawerNavigationOptions = React.useMemo(() => {
        if (!isDesktopLayout) {
            // Phone: front drawer holding the session list (SidebarView), opened by a
            // swipe starting from the left part of the screen or the list button in the
            // compose home header. When the user isn't authenticated yet there's no
            // session list, so keep it disabled.
            if (!auth.isAuthenticated) {
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
                // Card-stack: on native the sidebar and the main content slide
                // TOGETHER as one filmstrip (drawerType 'slide') — two cards moving
                // side-by-side, neither covering the other. ('back' fixed the sidebar
                // and let content cover it; 'front' slides a panel over the top.)
                // CardStackScene adds scale + corner radius to the content for the card
                // look. Web keeps 'front' because its drawer progress is a 0/1 binary
                // jump (no per-frame value), so the scale would flicker.
                drawerType: (Platform.OS === 'web' ? 'front' : 'slide') as 'front' | 'slide',
                swipeEnabled: !selectionMode,
                // Full-screen open gesture: a right-swipe started anywhere on the screen
                // pulls the sidebar in (not just the left edge / left third). May contend
                // with in-page horizontal scroll — the drawer wins; narrow this back if
                // that becomes a problem.
                swipeEdgeWidth: windowWidth,
                drawerStyle: {
                    width: fullDrawerWidth,
                    // Solid background so the revealed sidebar reads as its own card
                    // (was transparent, fine for 'front' but shows through in 'back').
                    backgroundColor: theme.colors.surface,
                    borderRightWidth: 0,
                },
            } as any;
        }

        // Tablet: always permanent, just collapse width in zen mode.
        //
        // We deliberately do NOT animate `width` on web. A CSS transition on
        // the drawer width re-flowed the chat flex-1 sibling on every frame,
        // re-measuring the entire FlatList tree at ~15fps. Snapping the
        // width change makes the chat reflow exactly once. Native already
        // snaps because RN doesn't honor CSS transition properties.
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: 'white',
                borderRightWidth: 0,
                width: drawerWidth,
                overflow: 'hidden' as const,
            } as any,
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [isDesktopLayout, drawerWidth, windowWidth, auth.isAuthenticated, fullDrawerWidth, selectionMode, theme.colors.surface]);

    const drawerContent = React.useCallback(
        () => <SidebarView closeDrawerOnNavigate={!isDesktopLayout} />,
        [isDesktopLayout]
    );

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={(isDesktopLayout || auth.isAuthenticated) ? drawerContent : undefined}
            />
            {/* Persistent header overlay — always visible on desktop, same position regardless of zen mode */}
            {isDesktopLayout && (
                <PersistentHeader />
            )}
        </View>
    );
});

// Header block that stays in the same position whether zen mode is on or off
const PersistentHeader = React.memo(() => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const { width: windowWidth } = useWindowDimensions();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

    const routeHistory = useBrowserNavigationStore((s) => s.routeHistory);
    const canGoForward = useBrowserNavigationStore((s) => s.routeHistory ? canRouteForward(s.routeHistory) : false);
    const overlayCanBack = useOverlayNav((s) => s.canBack);
    const overlayCanForward = useOverlayNav((s) => s.canForward);
    const canGoBack = routeHistory
        ? Platform.OS === 'web'
            ? canRouteBack(routeHistory)
            : canUseRouteBack(routeHistory, getNavigatorCanGoBack(router))
        : false;

    const handleZenToggle = React.useCallback(() => {
        setZenMode(!zenMode);
    }, [zenMode, setZenMode]);

    const handleBack = React.useCallback(() => {
        // Intra-session overlay (file diff / file view) consumes back first,
        // so the chat → diff → file flow can be unwound without a close X.
        if (useOverlayNav.getState().back()) return;
        const nav = useBrowserNavigationStore.getState();
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            if (!nav.routeHistory || !canRouteBack(nav.routeHistory)) return;
            nav.markRouteBack();
            window.history.back();
            return;
        }
        if (!nav.routeHistory || !canUseRouteBack(nav.routeHistory, getNavigatorCanGoBack(router))) return;
        nav.markRouteBack();
        router.back();
    }, [router]);

    const handleForward = React.useCallback(() => {
        if (useOverlayNav.getState().forward()) return;
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            const nav = useBrowserNavigationStore.getState();
            if (!nav.routeHistory || !canRouteForward(nav.routeHistory)) return;
            nav.markRouteForward();
            window.history.forward();
        }
    }, []);

    const canGoBackEffective = canGoBack || overlayCanBack;
    const canGoForwardEffective = canGoForward || overlayCanForward;
    const sidebarWidth = zenMode ? 0 : getDesktopSidebarWidth(windowWidth);

    return (
        <View
            style={{
                position: 'absolute',
                top: 0,
                left: sidebarWidth + 16,
                right: 0,
                paddingTop: safeArea.top,
                paddingLeft: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16,
                paddingRight: 16,
                height: safeArea.top + headerHeight,
                flexDirection: 'row',
                alignItems: 'center',
                zIndex: 1100,
                // RN Web 无法稳定转换 style.pointerEvents="box-none"：全宽浮层在控件外
                // 仍可能成为命中目标。普通 Web 使用 none，并由子控件的 auto 恢复点击；
                // Tauri 与原生端保留 box-none，避免破坏窗口拖拽区。
                pointerEvents: getPersistentHeaderPointerEvents({
                    isWeb: Platform.OS === 'web',
                    inTauri,
                }),
            }}
            {...(inTauri ? { dataSet: { tauriDragRegion: 'true' } } : {})}
        >
            {/* Zen / Back / Forward buttons */}
            <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, pointerEvents: 'auto' }}
                testID="desktop-navigation-controls"
                {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
            >
                <Pressable
                    onPress={handleZenToggle}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel={t('zen.toggle')}
                    accessibilityRole="button"
                    accessibilityState={{ selected: zenMode }}
                    testID="desktop-navigation-zen-button"
                >
                    <Image
                        source={require('@/assets/images/zen-icon.png')}
                        contentFit="contain"
                        style={{ width: 18, height: 18 }}
                        tintColor={zenMode ? theme.colors.textLink : theme.colors.header.tint}
                    />
                </Pressable>
                <Pressable
                    onPress={handleBack}
                    disabled={!canGoBackEffective}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoBackEffective ? 1 : 0.3 }}
                    testID="desktop-navigation-back-button"
                >
                    <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
                </Pressable>
                {Platform.OS === 'web' && (
                    <Pressable onPress={handleForward} disabled={!canGoForwardEffective} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoForwardEffective ? 1 : 0.3 }}>
                        <Ionicons name="chevron-forward" size={20} color={theme.colors.header.tint} />
                    </Pressable>
                )}
            </View>
        </View>
    );
});
