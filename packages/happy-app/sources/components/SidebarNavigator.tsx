import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { useWindowDimensions, View, Pressable, Platform, BackHandler, Text } from 'react-native';
import { useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { canRouteBack, canRouteForward, canUseRouteBack, getNavigatorCanGoBack } from '@/navigation/browserNavigation';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { useSessionSelection } from '@/hooks/useSessionSelection';
import {
    DesktopWorkspaceLayoutProvider,
    useDesktopWorkspaceLayout,
} from '@/hooks/useDesktopWorkspaceLayout';
import { DesktopPanelResizeHandle } from './DesktopPanelResizeHandle';
import { DesktopShortcutTooltip } from './DesktopShortcutTooltip';
import { KeyboardShortcutsProvider } from './KeyboardShortcuts';
import {
    getDesktopPanelShortcutPresentation,
    getPersistentHeaderPointerEvents,
    PERSISTENT_NAVIGATION_BUTTON_SIZE,
    PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
    PERSISTENT_NAVIGATION_SIDEBAR_CONTROL_WIDTH,
    PERSISTENT_NAVIGATION_ZEN_CONTROL_WIDTH,
    TAURI_HEADER_CONTROL_LEFT,
    DESKTOP_PRIMARY_NAVIGATION_WIDTH,
    DESKTOP_WORKSPACE_OUTER_GAP,
} from '@/utils/desktopNavigationLayout';

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();

    return (
        <DesktopWorkspaceLayoutProvider enabled={auth.isAuthenticated && isTablet}>
            <KeyboardShortcutsProvider>
                <SidebarNavigatorContent />
            </KeyboardShortcutsProvider>
        </DesktopWorkspaceLayoutProvider>
    );
});

const SidebarNavigatorContent = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const { theme } = useUnistyles();
    const {
        leftExpandedWidth,
        leftPinned,
        leftVisible: showSidebar,
        setLeftSidebarHovered,
        setLeftSidebarFocused,
    } = useDesktopWorkspaceLayout();
    const selectionMode = useSessionSelection((s) => s.active);
    const clearSelection = useSessionSelection((s) => s.clearSelection);
    const isDesktopLayout = auth.isAuthenticated && isTablet;
    const { width: windowWidth } = useWindowDimensions();

    // Calculate target drawer width
    const fullDrawerWidth = React.useMemo(() => {
        if (!isDesktopLayout) return Math.max(0, Math.min(windowWidth - 16, 420));
        return leftExpandedWidth + (Platform.OS === 'web' ? DESKTOP_PRIMARY_NAVIGATION_WIDTH : 0);
    }, [isDesktopLayout, leftExpandedWidth, windowWidth]);
    const fixedRail = isDesktopLayout && Platform.OS === 'web';
    const drawerWidth = (fixedRail ? leftPinned : showSidebar) ? fullDrawerWidth : fixedRail ? DESKTOP_PRIMARY_NAVIGATION_WIDTH : 0;
    const hideDrawer = isDesktopLayout && !showSidebar && !fixedRail;

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

        // Desktop keeps the rail permanent. Only a pinned panel reserves layout
        // width; hover reveal animates the secondary column as an overlay.
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
                backgroundColor: theme.colors.groupped.background,
                borderRightWidth: 0,
                width: drawerWidth,
                zIndex: 10,
                overflow: Platform.OS === 'web' ? 'visible' as const : 'hidden' as const,
            } as any,
            sceneStyle: Platform.OS === 'web' ? {
                margin: DESKTOP_WORKSPACE_OUTER_GAP, marginLeft: 0, borderRadius: 20, overflow: 'hidden',
                backgroundColor: theme.colors.surface,
            } : undefined,
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [isDesktopLayout, drawerWidth, windowWidth, auth.isAuthenticated, fullDrawerWidth, selectionMode, theme.colors.surface, theme.colors.groupped.background]);

    const drawerContent = React.useCallback(
        ({ navigation }: { navigation: { closeDrawer: () => void } }) => (
            <View
                aria-hidden={hideDrawer}
                accessibilityElementsHidden={hideDrawer}
                importantForAccessibility={hideDrawer ? 'no-hide-descendants' : 'auto'}
                {...(Platform.OS !== 'web' ? {
                    pointerEvents: hideDrawer ? 'none' : 'auto',
                } : {})}
                {...(fixedRail ? {
                    // Match Pressable's pointer-based hover events. Mixing mouseleave
                    // with pointerenter can cancel the pin button's hover on arrival.
                    onPointerEnter: (event: React.PointerEvent) => { if (event.pointerType !== 'touch') setLeftSidebarHovered(true); },
                    onPointerLeave: (event: React.PointerEvent) => { if (event.pointerType !== 'touch') setLeftSidebarHovered(false); },
                    onFocus: (event: React.FocusEvent<HTMLElement>) => {
                        if (event.target.matches(':focus-visible')) setLeftSidebarFocused(true);
                    },
                    onBlur: (event: React.FocusEvent<HTMLElement>) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLeftSidebarFocused(false);
                    },
                } as any : {})}
                style={[
                    styles.drawerContent,
                    isDesktopLayout && Platform.OS === 'web' && { width: drawerWidth },
                    Platform.OS === 'web' && {
                        pointerEvents: hideDrawer ? 'none' : 'auto',
                    },
                    isDesktopLayout && !showSidebar && Platform.OS !== 'web' && styles.drawerContentHidden,
                ]}
                testID={isDesktopLayout ? 'desktop-left-sidebar' : undefined}
            >
                <SidebarView
                    onCloseDrawer={() => navigation.closeDrawer()}
                    closeDrawerOnNavigate={!isDesktopLayout}
                    desktopDensity={isDesktopLayout}
                    desktopPrimaryNavigation={fixedRail}
                    desktopSecondaryVisible={showSidebar}
                    desktopSecondaryWidth={leftExpandedWidth}
                />
            </View>
        ),
        [leftExpandedWidth, drawerWidth, fixedRail, hideDrawer, isDesktopLayout, showSidebar, setLeftSidebarHovered, setLeftSidebarFocused]
    );

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={(isDesktopLayout || auth.isAuthenticated) ? drawerContent : undefined}
            />
            {/* Persistent header overlay — always visible on desktop, same position regardless of zen mode */}
            {isDesktopLayout && (
                <PersistentHeader />
            )}
            {isDesktopLayout && showSidebar && (
                <DesktopPanelResizeHandle
                    accessibilityLabel={t('desktopWorkspace.resizePanel', {
                        panel: t('desktopWorkspace.sessions'),
                    })}
                    offset={leftExpandedWidth + (Platform.OS === 'web' ? DESKTOP_PRIMARY_NAVIGATION_WIDTH : 0) - 5}
                    side="left"
                />
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
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const {
        resizingSide,
        leftPinned: sidebarPinned,
        leftVisible: sidebarVisible,
        leftExpandedWidth: sidebarWidth,
        toggleLeftSidebar,
        setLeftSidebarHovered,
        setLeftSidebarFocused,
    } = useDesktopWorkspaceLayout();
    const [sidebarTooltipVisible, setSidebarTooltipVisible] = React.useState(false);
    const [zenTooltipVisible, setZenTooltipVisible] = React.useState(false);
    const [backTooltipVisible, setBackTooltipVisible] = React.useState(false);
    const [forwardTooltipVisible, setForwardTooltipVisible] = React.useState(false);
    const shortcuts = getDesktopPanelShortcutPresentation();
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
    const sidebarToggleLabel = Platform.OS === 'web'
        ? (sidebarPinned ? t('desktopWorkspace.unpinSessions') : t('desktopWorkspace.pinSessions'))
        : (sidebarVisible ? t('desktopWorkspace.hideSessions') : t('desktopWorkspace.showSessions'));
    const sidebarSelected = Platform.OS === 'web' ? sidebarPinned : sidebarVisible;

    return (
        <View
            {...(Platform.OS === 'web' ? { dataSet: { happyMotion: resizingSide ? undefined : 'desktop-sidebar-controls' } } : {})}
            style={{
                position: 'absolute',
                top: Platform.OS === 'web' ? DESKTOP_WORKSPACE_OUTER_GAP : 0,
                left: (sidebarVisible ? sidebarWidth : 0) + (Platform.OS === 'web' ? DESKTOP_PRIMARY_NAVIGATION_WIDTH : 0) + 16,
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
            {/* Sidebar / Zen / Back / Forward buttons */}
            <View
                style={styles.navigationControls}
                testID="desktop-navigation-controls"
                {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
            >
                <View style={styles.sidebarToggleWrapper}>
                    <Pressable
                        onBlur={() => { setSidebarTooltipVisible(false); setLeftSidebarFocused(false); }}
                        onFocus={(event) => {
                            setSidebarTooltipVisible(true);
                            if (Platform.OS === 'web' && (event.target as unknown as HTMLElement).matches?.(':focus-visible')) setLeftSidebarFocused(true);
                        }}
                        onHoverIn={() => { setSidebarTooltipVisible(true); if (sidebarVisible) setLeftSidebarHovered(true); }}
                        onHoverOut={() => { setSidebarTooltipVisible(false); setLeftSidebarHovered(false); }}
                        onPress={toggleLeftSidebar}
                        hitSlop={8}
                        style={({ pressed }) => [
                            styles.sidebarToggle,
                            sidebarSelected && styles.toggleSelected,
                            pressed && styles.togglePressed,
                        ]}
                        aria-expanded={sidebarVisible}
                        aria-pressed={sidebarSelected}
                        accessibilityHint={`${sidebarToggleLabel} (${shortcuts.leftLabel})`}
                        accessibilityLabel={sidebarToggleLabel}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: sidebarVisible, selected: sidebarSelected }}
                        {...({
                            'aria-keyshortcuts': shortcuts.leftAria,
                        } as any)}
                        testID="desktop-navigation-sidebar-button"
                    >
                        <Ionicons
                            name={sidebarSelected ? 'folder-open-outline' : 'folder-outline'}
                            size={19}
                            color={theme.colors.header.tint}
                        />
                    </Pressable>
                    <DesktopShortcutTooltip
                        label={sidebarToggleLabel}
                        shortcut={shortcuts.leftLabel}
                        testID="desktop-navigation-sidebar-tooltip"
                        visible={sidebarTooltipVisible}
                    />
                </View>
                <View style={styles.headerIconWrapper}>
                    <Pressable
                        onBlur={() => setZenTooltipVisible(false)}
                        onFocus={() => setZenTooltipVisible(true)}
                        onHoverIn={() => setZenTooltipVisible(true)}
                        onHoverOut={() => setZenTooltipVisible(false)}
                        onPress={handleZenToggle}
                        hitSlop={8}
                        style={({ pressed }) => [
                            styles.zenToggle,
                            zenMode && styles.zenToggleSelected,
                            pressed && styles.togglePressed,
                        ]}
                        aria-selected={zenMode}
                        accessibilityLabel={t('zen.toggle')}
                        accessibilityRole="button"
                        accessibilityState={{ selected: zenMode }}
                        testID="desktop-navigation-zen-button"
                    >
                        <Ionicons
                            name="leaf-outline"
                            size={19}
                            color={theme.colors.status.connected}
                            dataSet={{ iconName: 'leaf-outline' }}
                            testID="desktop-navigation-zen-icon"
                        />
                    </Pressable>
                    <DesktopShortcutTooltip
                        label={t('zen.toggle')}
                        testID="desktop-navigation-zen-tooltip"
                        visible={zenTooltipVisible}
                    />
                </View>
                <View style={styles.headerIconWrapper}>
                    <Pressable
                        accessibilityLabel={t('common.back')}
                        accessibilityRole="button"
                        onBlur={() => setBackTooltipVisible(false)}
                        onFocus={() => setBackTooltipVisible(true)}
                        onHoverIn={() => setBackTooltipVisible(true)}
                        onHoverOut={() => setBackTooltipVisible(false)}
                        onPress={handleBack}
                        disabled={!canGoBackEffective}
                        hitSlop={10}
                        style={[styles.historyButton, !canGoBackEffective && styles.historyButtonDisabled]}
                        testID="desktop-navigation-back-button"
                    >
                        <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
                    </Pressable>
                    <DesktopShortcutTooltip
                        label={t('common.back')}
                        testID="desktop-navigation-back-tooltip"
                        visible={backTooltipVisible}
                    />
                </View>
                {Platform.OS === 'web' && (
                    <View style={styles.headerIconWrapper}>
                        <Pressable
                            accessibilityLabel={t('desktopWorkspace.forward')}
                            accessibilityRole="button"
                            onBlur={() => setForwardTooltipVisible(false)}
                            onFocus={() => setForwardTooltipVisible(true)}
                            onHoverIn={() => setForwardTooltipVisible(true)}
                            onHoverOut={() => setForwardTooltipVisible(false)}
                            onPress={handleForward}
                            disabled={!canGoForwardEffective}
                            hitSlop={10}
                            style={[styles.historyButton, !canGoForwardEffective && styles.historyButtonDisabled]}
                            testID="desktop-navigation-forward-button"
                        >
                            <Ionicons name="chevron-forward" size={20} color={theme.colors.header.tint} />
                        </Pressable>
                        <DesktopShortcutTooltip
                            align="right"
                            label={t('desktopWorkspace.forward')}
                            testID="desktop-navigation-forward-tooltip"
                            visible={forwardTooltipVisible}
                        />
                    </View>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    drawerContent: {
        backgroundColor: theme.colors.surface,
        flex: 1,
        minWidth: 0,
    },
    drawerContentHidden: {
        display: 'none',
    },
    navigationControls: {
        width: PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'auto',
    },
    sidebarToggleWrapper: {
        position: 'relative',
        width: PERSISTENT_NAVIGATION_SIDEBAR_CONTROL_WIDTH,
        height: PERSISTENT_NAVIGATION_BUTTON_SIZE,
    },
    sidebarToggle: {
        width: '100%',
        height: PERSISTENT_NAVIGATION_BUTTON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
    },
    toggleSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    togglePressed: {
        opacity: 0.7,
    },
    headerIconWrapper: {
        position: 'relative',
        width: PERSISTENT_NAVIGATION_BUTTON_SIZE,
        height: PERSISTENT_NAVIGATION_BUTTON_SIZE,
    },
    zenToggle: {
        width: PERSISTENT_NAVIGATION_ZEN_CONTROL_WIDTH,
        height: PERSISTENT_NAVIGATION_BUTTON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
    },
    zenToggleSelected: {
        borderColor: theme.colors.status.connected,
        backgroundColor: theme.colors.surfacePressed,
    },
    historyButton: {
        width: PERSISTENT_NAVIGATION_BUTTON_SIZE,
        height: PERSISTENT_NAVIGATION_BUTTON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    historyButtonDisabled: {
        opacity: 0.3,
    },
}));
