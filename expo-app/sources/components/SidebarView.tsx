import { useSocketStatus, useFriendRequests, useSetting, useSyncError } from '@/sync/storage';
import * as React from 'react';
import { Platform, Text, View, Pressable, useWindowDimensions } from 'react-native';
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
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/sync/sync';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { useInboxFriendsEnabled } from '@/hooks/useInboxFriendsEnabled';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.groupped.background,
        position: 'relative',
        zIndex: 100,
        overflow: 'visible',
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
        overflow: 'visible',
    },
    titleContainerLeft: {
        flex: 1,
        flexDirection: 'column',
        alignItems: 'flex-start',
        marginLeft: 8,
        justifyContent: 'center',
        overflow: 'visible',
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
    banner: {
        marginHorizontal: 12,
        marginBottom: 8,
        marginTop: 6,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    bannerText: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    bannerButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 10,
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    bannerButtonText: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
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
    const syncError = useSyncError();
    const popoverBoundaryRef = React.useRef<any>(null);
    const friendRequests = useFriendRequests();
    const inboxHasContent = useInboxHasContent();
    const experimentsEnabled = useSetting('experiments');
    const expZen = useSetting('expZen');
    const inboxFriendsEnabled = useInboxFriendsEnabled();

    // Compute connection status once per render (theme-reactive, no stale memoization)
    const connectionStatus = (() => {
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
    })();

    // Calculate sidebar width and determine title positioning
    // Uses same formula as SidebarNavigator.tsx:18 for consistency
    const { width: windowWidth } = useWindowDimensions();
    const sidebarWidth = Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    const showZen = experimentsEnabled && expZen;
    // With Zen enabled: 4 icons (148px total), threshold 408px > max 360px → always left-justify
    // Without Zen: 3 icons (108px total), threshold 328px → left-justify below ~340px
    const shouldLeftJustify = showZen || sidebarWidth < 340;

    const handleNewSession = React.useCallback(() => {
        router.push('/new');
    }, [router]);

    // Title content used in both centered and left-justified modes (DRY)
    const titleContent = (
        <>
            <Text style={styles.titleText}>{t('sidebar.sessionsTitle')}</Text>
            {connectionStatus.text ? (
                <View style={Platform.OS === 'web' ? ({ pointerEvents: 'auto' } as any) : undefined}>
                    <ConnectionStatusControl
                        variant="sidebar"
                        alignSelf={shouldLeftJustify ? 'flex-start' : 'center'}
                    />
                </View>
            ) : null}
        </>
    );

    return (
        <>
            <View ref={popoverBoundaryRef} style={[styles.container, { paddingTop: safeArea.top }]}>
                <PopoverBoundaryProvider boundaryRef={popoverBoundaryRef}>
                <View style={[styles.header, { height: headerHeight }]}>
                    {/* Logo - always first */}
                    <View style={styles.logoContainer}>
                        <Image
                            source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                            contentFit="contain"
                            style={[styles.logo, { height: 24, width: 24 }]}
                        />
                    </View>

                    {/* Left-justified title - in document flow, prevents overlap */}
                    {shouldLeftJustify && (
                        <View style={styles.titleContainerLeft}>
                            {titleContent}
                        </View>
                    )}

                    {/* Navigation icons */}
                    <View style={styles.rightContainer}>
                        {showZen && (
                            <Pressable
                                onPress={() => router.push('/(app)/zen')}
                                hitSlop={15}
                            >
                                <Image
                                    source={require('@/assets/images/brutalist/Brutalism 3.png')}
                                    contentFit="contain"
                                    style={[{ width: 32, height: 32 }]}
                                    tintColor={theme.colors.header.tint}
                                />
                            </Pressable>
                        )}
                        {inboxFriendsEnabled && (
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
                        )}
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
                        <Pressable
                            onPress={handleNewSession}
                            hitSlop={15}
                        >
                            <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
                        </Pressable>
                    </View>

                    {/* Centered title - absolute positioned over full header */}
                    {!shouldLeftJustify && (
                        <View
                            // On native, this overlay must be `box-none` so it doesn't block the header buttons.
                            // On web, use CSS-compatible pointer-events values (RN `box-none` isn't valid CSS).
                            pointerEvents={Platform.OS === 'web' ? undefined : 'box-none'}
                            style={[styles.titleContainer, Platform.OS === 'web' ? ({ pointerEvents: 'none' } as any) : null]}
                        >
                            {titleContent}
                        </View>
                    )}
                </View>
                {(syncError || socketStatus.status === 'error' || socketStatus.status === 'disconnected') && (
                    <View style={styles.banner}>
                        <Text style={styles.bannerText} numberOfLines={2}>
                            {syncError?.message
                                ?? socketStatus.lastError
                                ?? (socketStatus.status === 'disconnected' ? t('status.disconnected') : t('status.error'))}
                        </Text>
                        {syncError?.kind === 'auth' ? (
                            <Pressable
                                onPress={() => router.push('/restore')}
                                style={styles.bannerButton}
                                accessibilityRole="button"
                            >
                                <Text style={styles.bannerButtonText}>{t('connect.restoreAccount')}</Text>
                            </Pressable>
                        ) : syncError?.retryable !== false ? (
                            <Pressable
                                onPress={() => sync.retryNow()}
                                style={styles.bannerButton}
                                accessibilityRole="button"
                            >
                                <Text style={styles.bannerButtonText}>{t('common.retry')}</Text>
                            </Pressable>
                        ) : null}
                    </View>
                )}
                {realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="sidebar" />
                )}
                <MainView variant="sidebar" />
                </PopoverBoundaryProvider>
            </View>
            <FABWide onPress={handleNewSession} />
        </>
    )
});
