import { useSocketStatus, useFriendRequests } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { FABWide } from './FABWide';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';
import { MainView } from './MainView';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useInboxHasContent } from '@/hooks/useInboxHasContent';

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
        position: 'relative',
    },
    logoContainer: {
        width: 32,
    },
    logo: {
        height: 24,
        width: 24,
    },
    titleContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        flexDirection: 'column',
        alignItems: 'center',
        pointerEvents: 'none',
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
        marginLeft: 'auto',
        alignItems: 'flex-end',
        flexDirection: 'row',
        gap: 8,
    },
    settingsButton: {
        color: theme.colors.header.tint,
    },
    notificationButton: {
        position: 'relative',
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -4,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        ...Typography.default('semiBold'),
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
    indicatorDot: {
        position: 'absolute',
        top: 0,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text,
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const socketStatus = useSocketStatus();
    const realtimeStatus = useRealtimeStatus();
    const friendRequests = useFriendRequests();
    const inboxHasContent = useInboxHasContent();

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

    const handleNewSession = React.useCallback(() => {
        router.push('/new');
    }, [router]);

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
                    <View style={styles.rightContainer}>
                        <Pressable
                            onPress={() => router.push('/(app)/inbox')}
                            hitSlop={15}
                            style={styles.notificationButton}
                        >
                            <Image
                                source={require('@/assets/images/brutalist/Brutalism 27.png')}
                                contentFit="contain"
                                style={[{ width: 32, height: 32 }]}
                                tintColor={theme.colors.header.tint}
                            />
                            {friendRequests.length > 0 && (
                                <View style={styles.badge}>
                                    <Text style={styles.badgeText}>
                                        {friendRequests.length > 99 ? '99+' : friendRequests.length}
                                    </Text>
                                </View>
                            )}
                            {inboxHasContent && friendRequests.length === 0 && (
                                <View style={styles.indicatorDot} />
                            )}
                        </Pressable>
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
                </View>
                {realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="sidebar" />
                )}
                <MainView variant="sidebar" />
            </View>
            <FABWide onPress={handleNewSession} />
        </>
    )
});
