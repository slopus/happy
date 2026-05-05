import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { useWindowDimensions, View, Text, Pressable, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable, useSocketStatus } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';

const TAURI_TRAFFIC_LIGHT_WIDTH = 72;

/**
 * Tracks navigation history to determine if back/forward is possible.
 * We maintain our own stack + cursor because the web History API
 * doesn't expose whether forward entries exist.
 */
function useNavHistory() {
    const pathname = usePathname();
    const historyRef = React.useRef<string[]>([pathname]);
    const cursorRef = React.useRef(0);
    const directionRef = React.useRef<'back' | 'forward' | null>(null);
    const [canGoBack, setCanGoBack] = React.useState(false);
    const [canGoForward, setCanGoForward] = React.useState(false);

    React.useEffect(() => {
        const dir = directionRef.current;
        directionRef.current = null;

        if (dir === 'back') {
            cursorRef.current = Math.max(0, cursorRef.current - 1);
        } else if (dir === 'forward') {
            cursorRef.current = Math.min(historyRef.current.length - 1, cursorRef.current + 1);
        } else {
            // Regular navigation — trim forward entries and push
            const cursor = cursorRef.current;
            historyRef.current = historyRef.current.slice(0, cursor + 1);
            historyRef.current.push(pathname);
            cursorRef.current = historyRef.current.length - 1;
        }

        setCanGoBack(cursorRef.current > 0);
        setCanGoForward(cursorRef.current < historyRef.current.length - 1);
    }, [pathname]);

    const markBack = React.useCallback(() => { directionRef.current = 'back'; }, []);
    const markForward = React.useCallback(() => { directionRef.current = 'forward'; }, []);

    return { canGoBack, canGoForward, markBack, markForward };
}

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const zenMode = useLocalSetting('zenMode');
    const isDesktopLayout = auth.isAuthenticated && isTablet;
    const showSidebar = isDesktopLayout && !zenMode;
    const { width: windowWidth } = useWindowDimensions();

    // Calculate target drawer width
    const fullDrawerWidth = React.useMemo(() => {
        if (!isDesktopLayout) return 280;
        return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    }, [windowWidth, isDesktopLayout]);
    const drawerWidth = showSidebar ? fullDrawerWidth : 0;

    const drawerNavigationOptions = React.useMemo(() => {
        if (!isDesktopLayout) {
            // Non-tablet: use front drawer, hidden
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

        // Tablet: always permanent, just collapse width in zen mode
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: 'white',
                borderRightWidth: 0,
                width: drawerWidth,
                overflow: 'hidden' as const,
                ...(Platform.OS === 'web' ? {
                    transitionProperty: 'width',
                    transitionDuration: '250ms',
                    transitionTimingFunction: 'cubic-bezier(0.33, 1, 0.68, 1)',
                } : {}),
            } as any,
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [isDesktopLayout, drawerWidth]);

    const drawerContent = React.useCallback(
        () => <SidebarView />,
        []
    );

    return (
        <View style={{ flex: 1 }}>
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={isDesktopLayout ? drawerContent : undefined}
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
    const socketStatus = useSocketStatus();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

    const connectionStatus = (() => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return { color: theme.colors.status.connected, isPulsing: false, text: t('status.connected'), textColor: theme.colors.status.connected };
            case 'connecting':
                return { color: theme.colors.status.connecting, isPulsing: true, text: t('status.connecting'), textColor: theme.colors.status.connecting };
            case 'disconnected':
                return { color: theme.colors.status.disconnected, isPulsing: false, text: t('status.disconnected'), textColor: theme.colors.status.disconnected };
            case 'error':
                return { color: theme.colors.status.error, isPulsing: false, text: t('status.error'), textColor: theme.colors.status.error };
            default:
                return { color: theme.colors.status.default, isPulsing: false, text: '', textColor: theme.colors.status.default };
        }
    })();

    const { canGoBack, canGoForward, markBack, markForward } = useNavHistory();

    const handleZenToggle = React.useCallback(() => {
        setZenMode(!zenMode);
    }, [zenMode, setZenMode]);

    const handleBack = React.useCallback(() => {
        markBack();
        router.back();
    }, [router, markBack]);

    const handleForward = React.useCallback(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            markForward();
            window.history.forward();
        }
    }, [markForward]);

    return (
        <View
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                paddingTop: safeArea.top,
                paddingLeft: isMacTauri ? TAURI_TRAFFIC_LIGHT_WIDTH + 16 : 16,
                paddingRight: 16,
                height: safeArea.top + headerHeight,
                flexDirection: 'row',
                alignItems: 'center',
                zIndex: 1100,
            }}
            pointerEvents="box-none"
            {...(inTauri ? { dataSet: { tauriDragRegion: 'true' } } : {})}
        >
            {/* Title + status */}
            <View>
                <Text style={{
                    fontSize: 17,
                    fontWeight: '600',
                    color: theme.colors.header.tint,
                    ...Typography.default('semiBold'),
                }}>
                    {t('sidebar.sessionsTitle')}
                </Text>
                {connectionStatus.text ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: -2 }}>
                        <StatusDot
                            color={connectionStatus.color}
                            isPulsing={connectionStatus.isPulsing}
                            size={6}
                            style={{ marginRight: 4 }}
                        />
                        <Text style={{
                            fontSize: 11,
                            fontWeight: '500',
                            lineHeight: 16,
                            color: connectionStatus.textColor,
                            ...Typography.default(),
                        }}>
                            {connectionStatus.text}
                        </Text>
                    </View>
                ) : null}
            </View>

            {/* Back / Forward / Zen buttons */}
            <View
                style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, gap: 4 }}
                pointerEvents="auto"
                {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
            >
                <Pressable onPress={handleBack} disabled={!canGoBack} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoBack ? 1 : 0.3 }}>
                    <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
                </Pressable>
                {Platform.OS === 'web' && (
                    <Pressable onPress={handleForward} disabled={!canGoForward} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoForward ? 1 : 0.3 }}>
                        <Ionicons name="chevron-forward" size={20} color={theme.colors.header.tint} />
                    </Pressable>
                )}
                <Pressable
                    onPress={handleZenToggle}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel={t('zen.toggle')}
                >
                    <Image
                        source={require('@/assets/images/zen-icon.png')}
                        contentFit="contain"
                        style={{ width: 18, height: 18 }}
                        tintColor={zenMode ? theme.colors.textLink : theme.colors.header.tint}
                    />
                </Pressable>
            </View>
        </View>
    );
});
