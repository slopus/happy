import { useSocketStatus } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { FABWide } from './FABWide';

import { MainView } from './MainView';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        borderColor: theme.colors.divider,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        backgroundColor: theme.colors.groupped.background,
    },
    leftGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 28,
    },
    centerGroup: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    rightGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 28,
    },
    titleText: {
        fontSize: 15,
        letterSpacing: 2,
        textTransform: 'uppercase' as const,
        color: theme.colors.header.tint,
        ...Typography.brand(),
    },
    iconButton: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Status colors
    statusConnected: {
        color: theme.colors.status.connected,
    },
    statusConnecting: {
        color: theme.colors.status.connecting,
    },
    statusDisconnected: {
        color: theme.colors.status.disconnected,
    },
    statusError: {
        color: theme.colors.status.error,
    },
    statusDefault: {
        color: theme.colors.status.default,
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const socketStatus = useSocketStatus();

    // Compute connection status color
    const statusColor = (() => {
        switch (socketStatus.status) {
            case 'connected': return styles.statusConnected.color;
            case 'connecting': return styles.statusConnecting.color;
            case 'disconnected': return styles.statusDisconnected.color;
            case 'error': return styles.statusError.color;
            default: return styles.statusDefault.color;
        }
    })();
    const isPulsing = socketStatus.status === 'connecting';

    const handleNewSession = React.useCallback(() => {
        router.push('/new');
    }, [router]);

    // Extract current path for toggle behavior
    const pathname = usePathname();

    const handleSettingsPress = React.useCallback(() => {
        if (pathname.startsWith('/settings')) {
            router.back();
        } else {
            router.push('/settings');
        }
    }, [router, pathname]);

    const handleFilesPress = React.useCallback(() => {
        if (pathname === '/files') {
            router.back();
        } else {
            router.push('/files');
        }
    }, [router, pathname]);
    const currentSessionId = React.useMemo(() => {
        const match = pathname.match(/\/session\/([^/]+)/);
        return match ? match[1] : null;
    }, [pathname]);

    const handleSessionFilesPress = React.useCallback(() => {
        if (currentSessionId) {
            window.dispatchEvent(new CustomEvent('toggle-file-browser', { detail: { sessionId: currentSessionId } }));
        }
    }, [currentSessionId]);

    return (
        <>
            <View style={[styles.container, { paddingTop: safeArea.top }]}>
                <View style={[styles.header, { height: headerHeight }]}>
                    {/* Left: settings grid */}
                    <View style={styles.leftGroup}>
                        <Pressable
                            onPress={handleSettingsPress}
                            hitSlop={10}
                            style={styles.iconButton}
                        >
                            <Ionicons name="grid-outline" size={18} color={theme.colors.header.tint} />
                        </Pressable>
                    </View>

                    {/* Center: indicator + logo */}
                    <View style={styles.centerGroup}>
                        <StatusDot
                            color={statusColor}
                            isPulsing={isPulsing}
                            size={8}
                        />
                        <Text style={styles.titleText}>chatai.304</Text>
                    </View>

                    {/* Right: add session */}
                    <View style={styles.rightGroup}>
                        <Pressable
                            onPress={handleNewSession}
                            hitSlop={10}
                            style={styles.iconButton}
                        >
                            <Ionicons name="add-outline" size={22} color={theme.colors.header.tint} />
                        </Pressable>
                    </View>
                </View>

                <MainView variant="sidebar" />
            </View>
            <FABWide onFilesPress={handleFilesPress} onSessionFilesPress={currentSessionId ? handleSessionFilesPress : undefined} />
        </>
    )
});
