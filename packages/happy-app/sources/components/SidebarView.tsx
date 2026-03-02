import { useSocketStatus } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
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

    const handleFilesPress = React.useCallback(() => {
        router.push('/files');
    }, [router]);

    return (
        <>
            <View style={[styles.container, { paddingTop: safeArea.top }]}>
                <View style={[styles.header, { height: headerHeight }]}>
                    {/* Left: settings */}
                    <View style={styles.leftGroup}>
                        <Pressable
                            onPress={() => router.push('/settings')}
                            hitSlop={10}
                            style={styles.iconButton}
                        >
                            <Ionicons name="folder-outline" size={20} color={theme.colors.header.tint} />
                        </Pressable>
                    </View>

                    {/* Center: indicator + logo */}
                    <View style={styles.centerGroup}>
                        <StatusDot
                            color={statusColor}
                            isPulsing={isPulsing}
                            size={8}
                        />
                        <Text style={[styles.titleText, { WebkitTextStroke: '1.2px' } as any]}>chatai.304</Text>
                    </View>

                    {/* Right: add */}
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
            <FABWide onPress={handleNewSession} onFilesPress={handleFilesPress} />
        </>
    )
});
