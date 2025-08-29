import { useSessionListViewData, useEntitlement, useSocketStatus, useSetting } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable, ActivityIndicator, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionsList } from './SessionsList';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter, useSegments } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { FAB } from './FAB';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UpdateBanner } from './UpdateBanner';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.groupped.background,
    },
    logoContainer: {
        width: 32,
    },
    logo: {
        height: 24,
        width: 24,
    },
    titleContainer: {
        flex: 1,
        flexDirection: 'column',
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusDot: {
        marginRight: 4,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    rightContainer: {
        width: 32,
        alignItems: 'flex-end',
    },
    settingsButton: {
        color: theme.colors.header.tint,
    },
    contentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    loadingContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
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
    const sessionListViewData = useSessionListViewData();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const socketStatus = useSocketStatus();
    const isExperimental = useSetting('experiments');
    const realtimeStatus = useRealtimeStatus();

    // Get connection status styling (matching sessionUtils.ts pattern)
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: styles.statusConnected.color,
                    isPulsing: false,
                    text: t('status.connected'),
                    textColor: styles.statusConnected.color
                };
            case 'connecting':
                return {
                    color: styles.statusConnecting.color,
                    isPulsing: true,
                    text: t('status.connecting'),
                    textColor: styles.statusConnecting.color
                };
            case 'disconnected':
                return {
                    color: styles.statusDisconnected.color,
                    isPulsing: false,
                    text: t('status.disconnected'),
                    textColor: styles.statusDisconnected.color
                };
            case 'error':
                return {
                    color: styles.statusError.color,
                    isPulsing: false,
                    text: t('status.error'),
                    textColor: styles.statusError.color
                };
            default:
                return {
                    color: styles.statusDefault.color,
                    isPulsing: false,
                    text: '',
                    textColor: styles.statusDefault.color
                };
        }
    };

    const handleNewSession = () => {
        router.push('/new-session');
    }

    return (
        <>
            <View style={[styles.container, { paddingTop: safeArea.top }]}>
                <View style={[styles.header, { height: headerHeight }]}>
                    <View style={styles.logoContainer}>
                        <Image
                            source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                            contentFit="contain"
                            style={[styles.logo, { height: 24, width: 24 }]}
                        />
                    </View>
                    <View style={styles.titleContainer}>
                        <Text style={styles.titleText}>{t('sidebar.sessionsTitle')}</Text>
                        {getConnectionStatus().text && (
                            <View style={styles.statusContainer}>
                                <StatusDot
                                    color={getConnectionStatus().color}
                                    isPulsing={getConnectionStatus().isPulsing}
                                    size={6}
                                    style={styles.statusDot}
                                />
                                <Text style={[
                                    styles.statusText,
                                    { color: getConnectionStatus().textColor }
                                ]}>
                                    {getConnectionStatus().text}
                                </Text>
                            </View>
                        )}
                    </View>
                    <View style={styles.rightContainer}>
                        <Pressable
                            onPress={() => router.push('/settings')}
                            hitSlop={15}
                        >
                            <Image
                                source={require('@/assets/images/brutalist/Brutalism 9.png')}
                                contentFit="contain"
                                style={[{ width: 32, height: 32 }]}
                                tintColor={theme.colors.header.tint}
                            />
                        </Pressable>
                    </View>
                </View>
                {realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="sidebar" />
                )}
                <View style={styles.contentContainer}>
                    {sessionListViewData === null && (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </View>
                    )}
                    {sessionListViewData !== null && sessionListViewData.length === 0 && (
                        <View style={{ flex: 1, flexBasis: 0, flexGrow: 1, flexDirection: 'column', backgroundColor: theme.colors.groupped.background }}>
                            <UpdateBanner />
                            <EmptySessionsTablet />
                        </View>
                    )}
                    {sessionListViewData !== null && sessionListViewData.length > 0 && (
                        <SessionsList />
                    )}
                </View>
            </View>
            {isExperimental && (
                <FAB onPress={handleNewSession} />
            )}
        </>
    )
});
