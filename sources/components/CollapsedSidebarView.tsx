import * as React from 'react';
import { View, Pressable, Text, FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { StatusDot } from './StatusDot';
import { FABCompact } from './FABCompact';
import { CollapsibleSidebarEdge } from './CollapsibleSidebarEdge';
import { Avatar } from './Avatar';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getSessionAvatarId } from '@/utils/sessionUtils';
import { Session } from '@/sync/storageTypes';
import { Typography } from '@/constants/Typography';

interface CollapsedSidebarViewProps {
    onNewSession: () => void;
    connectionStatus: {
        color: string;
        isPulsing: boolean;
        text: string;
        textColor?: string;
    };
    friendRequestsCount: number;
    inboxHasContent: boolean;
    showExperiments: boolean;
}

const stylesheet = StyleSheet.create((theme) => ({
    outerContainer: {
        flex: 1,
        flexDirection: 'row',
    },
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        borderRightWidth: 0,
        alignItems: 'center',
    },
    header: {
        width: '100%',
        alignItems: 'center',
        paddingVertical: 8,
        gap: 8,
    },
    iconButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    logo: {
        height: 24,
        width: 24,
    },
    statusDotContainer: {
        marginTop: 4,
    },
    divider: {
        width: 32,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginVertical: 8,
    },
    sessionsList: {
        flex: 1,
        width: '100%',
    },
    sessionsContent: {
        alignItems: 'center',
        paddingTop: 8,
    },
    sessionItem: {
        width: 48,
        height: 48,
        marginBottom: 8,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    badge: {
        position: 'absolute',
        top: -2,
        right: -2,
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
    indicatorDot: {
        position: 'absolute',
        top: 2,
        right: 2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text,
    },
}));

export const CollapsedSidebarView = React.memo(({
    onNewSession,
    connectionStatus,
    friendRequestsCount,
    inboxHasContent,
    showExperiments,
}: CollapsedSidebarViewProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const pathname = usePathname();
    const sessionListViewData = useVisibleSessionListViewData();
    const navigateToSession = useNavigateToSession();

    // Extract active sessions, grouped by project path (alphabetically), sorted by createdAt within groups
    const sessions = React.useMemo(() => {
        const activeItem = sessionListViewData?.find(item => item.type === 'active-sessions');
        if (!activeItem || activeItem.type !== 'active-sessions') return [];

        // Group by project path
        const groups = new Map<string, Session[]>();
        activeItem.sessions.forEach(session => {
            const path = session.metadata?.path || '';
            if (!groups.has(path)) groups.set(path, []);
            groups.get(path)!.push(session);
        });

        // Sort within groups by createdAt (newest first), then flatten by sorted paths
        return Array.from(groups.keys()).sort().flatMap(path =>
            groups.get(path)!.sort((a, b) => b.createdAt - a.createdAt)
        );
    }, [sessionListViewData]);

    const renderSession = React.useCallback(({ item }: { item: Session }) => {
        const isSelected = pathname.startsWith(`/session/${item.id}`);
        const avatarId = getSessionAvatarId(item);
        return (
            <Pressable
                style={[styles.sessionItem, isSelected && styles.sessionItemSelected]}
                onPress={() => navigateToSession(item.id)}
            >
                <Avatar id={avatarId} size={40} flavor={item.metadata?.flavor} />
            </Pressable>
        );
    }, [pathname, navigateToSession, styles]);

    const keyExtractor = React.useCallback((item: Session) => item.id, []);

    return (
        <View style={styles.outerContainer}>
            <View style={[styles.container, { paddingTop: safeArea.top }]}>
                <View style={[styles.header, { minHeight: headerHeight }]}>
                    {/* Logo */}
                    <View style={styles.iconButton}>
                        <Image
                            source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                            contentFit="contain"
                            style={[styles.logo, { height: 24, width: 24 }]}
                        />
                    </View>

                    {/* Connection status */}
                    <View style={styles.statusDotContainer}>
                        <StatusDot
                            color={connectionStatus.color}
                            isPulsing={connectionStatus.isPulsing}
                            size={8}
                        />
                    </View>

                    <View style={styles.divider} />

                    {/* Zen button (if experiments enabled) */}
                    {showExperiments && (
                        <Pressable
                            style={styles.iconButton}
                            onPress={() => router.push('/(app)/zen')}
                            hitSlop={10}
                        >
                            <Image
                                source={require('@/assets/images/brutalist/Brutalism 3.png')}
                                contentFit="contain"
                                style={[{ width: 28, height: 28 }]}
                                tintColor={theme.colors.header.tint}
                            />
                        </Pressable>
                    )}

                    {/* Inbox button */}
                    <Pressable
                        style={styles.iconButton}
                        onPress={() => router.push('/(app)/inbox')}
                        hitSlop={10}
                    >
                        <Image
                            source={require('@/assets/images/brutalist/Brutalism 27.png')}
                            contentFit="contain"
                            style={[{ width: 28, height: 28 }]}
                            tintColor={theme.colors.header.tint}
                        />
                        {friendRequestsCount > 0 && (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>
                                    {friendRequestsCount > 99 ? '99+' : friendRequestsCount}
                                </Text>
                            </View>
                        )}
                        {inboxHasContent && friendRequestsCount === 0 && (
                            <View style={styles.indicatorDot} />
                        )}
                    </Pressable>

                    {/* Settings button */}
                    <Pressable
                        style={styles.iconButton}
                        onPress={() => router.push('/settings')}
                        hitSlop={10}
                    >
                        <Image
                            source={require('@/assets/images/brutalist/Brutalism 9.png')}
                            contentFit="contain"
                            style={[{ width: 28, height: 28 }]}
                            tintColor={theme.colors.header.tint}
                        />
                    </Pressable>
                </View>

                {/* Sessions list (avatars only) */}
                <FlatList
                    style={styles.sessionsList}
                    contentContainerStyle={[styles.sessionsContent, { paddingBottom: safeArea.bottom + 80 }]}
                    data={sessions}
                    renderItem={renderSession}
                    keyExtractor={keyExtractor}
                    showsVerticalScrollIndicator={false}
                />
                <FABCompact onPress={onNewSession} />
            </View>
            <CollapsibleSidebarEdge />
        </View>
    );
});
