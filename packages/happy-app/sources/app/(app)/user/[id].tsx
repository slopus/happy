import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, ActivityIndicator, Linking, Pressable, Platform, ActionSheetIOS, RefreshControl } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { useAuth } from '@/auth/AuthContext';
import { getUserProfile, sendFriendRequest, removeFriend } from '@/sync/apiFriends';
import { UserProfile, getDisplayName } from '@/sync/friendTypes';
import { Avatar } from '@/components/Avatar';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useHappyAction } from '@/hooks/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import { trackFriendsConnect } from '@/track';
import { showToast } from '@/components/Toast';
import { Ionicons } from '@expo/vector-icons';
import { useSharedSessions, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { fetchSessionsSharedByMe, SharedByMeSession } from '@/sync/apiSharing';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId } from '@/utils/sessionUtils';
import { StatusDot } from '@/components/StatusDot';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import type { ActionMenuItem } from '@/components/ActionMenu';
import { loadSharedByMeCache, saveSharedByMeCache } from '@/sync/persistence';

function getAccessLevelLabel(accessLevel?: 'view' | 'edit' | 'admin') {
    switch (accessLevel) {
        case 'view': return t('session.sharing.viewOnly');
        case 'edit': return t('session.sharing.canEdit');
        case 'admin': return t('session.sharing.canManage');
        default: return t('session.sharing.viewOnly');
    }
}

export default function UserProfileScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { credentials } = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const sharedSessions = useSharedSessions();
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [sharedByMeData, setSharedByMeData] = useState<SharedByMeSession[]>([]);
    const [menuVisible, setMenuVisible] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const filteredSharedSessions = useMemo(() => {
        if (!userProfile) return [];
        return sharedSessions.filter(session => session.owner === userProfile.id);
    }, [sharedSessions, userProfile]);

    // Sessions I shared with this user, resolved from local storage
    const sharedByMeSessions = useMemo(() => {
        const sessions = storage.getState().sessions;
        const result: { session: Session; accessLevel: 'view' | 'edit' | 'admin' }[] = [];
        for (const item of sharedByMeData) {
            const session = sessions[item.sessionId];
            if (session) {
                result.push({ session, accessLevel: item.accessLevel });
            }
        }
        return result;
    }, [sharedByMeData]);

    // Load cached "shared by me" data immediately, then refresh from API
    useEffect(() => {
        if (!id) return;
        const cached = loadSharedByMeCache(id);
        if (cached.length > 0) {
            setSharedByMeData(cached);
        }
    }, [id]);

    // Load profile and shared data
    const loadData = useCallback(async () => {
        if (!credentials || !id) return;
        try {
            const profile = await getUserProfile(credentials, id);
            setUserProfile(profile);
            fetchSessionsSharedByMe(credentials, id).then((data) => {
                setSharedByMeData(data);
                saveSharedByMeCache(id, data);
            }).catch(() => {});
        } catch (error) {
            console.error('Failed to load user profile:', error);
            Modal.alert(t('errors.failedToLoadProfile'), '', [
                {
                    text: t('common.ok'),
                    onPress: () => router.back()
                }
            ]);
        }
    }, [credentials, id]);

    // Load user profile on mount
    useEffect(() => {
        if (!credentials || !id) return;
        setIsLoading(true);
        loadData().finally(() => setIsLoading(false));
    }, [loadData]);

    // Pull-to-refresh handler
    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true);
        await loadData();
        setIsRefreshing(false);
    }, [loadData]);

    // Add friend / Accept request action
    const [addingFriend, addFriend] = useHappyAction(async () => {
        if (!credentials || !userProfile) return;

        const updatedProfile = await sendFriendRequest(credentials, userProfile.id);
        if (updatedProfile) {
            trackFriendsConnect();
            setUserProfile(updatedProfile);
            sync.refreshFriends();
            showToast(updatedProfile.status === 'friend'
                ? t('friends.requestAccepted')
                : t('friends.requestSent'));
        } else {
            Modal.alert(t('friends.bothMustHaveGithub'));
        }
    });

    // Remove friend / Cancel request / Reject request action
    const [removingFriend, handleRemoveFriend] = useHappyAction(async () => {
        if (!credentials || !userProfile) return;

        const previousStatus = userProfile.status;

        if (previousStatus === 'friend') {
            // Removing a friend
            const confirmed = await Modal.confirm(
                t('friends.removeFriend'),
                t('friends.removeFriendConfirm', { name: getDisplayName(userProfile) }),
                { confirmText: t('friends.remove'), destructive: true }
            );

            if (!confirmed) return;
        } else if (previousStatus === 'requested') {
            // Canceling a sent request
            const confirmed = await Modal.confirm(
                t('friends.cancelRequest'),
                t('friends.cancelRequestConfirm', { name: getDisplayName(userProfile) }),
                { confirmText: t('common.yes'), destructive: false }
            );

            if (!confirmed) return;
        }

        const updatedProfile = await removeFriend(credentials, userProfile.id);
        if (updatedProfile) {
            setUserProfile(updatedProfile);
            sync.refreshFriends();

            // Remove related feed item (friend_request/friend_accepted) from local state
            const feedItems = storage.getState().feedItems;
            const itemToRemove = feedItems.find(item =>
                (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')
                && item.body.uid === userProfile.id
            );
            if (itemToRemove) {
                storage.getState().removeFeedItem(itemToRemove.id);
            }

            showToast(previousStatus === 'friend'
                ? t('friends.friendRemoved')
                : t('friends.requestRejected'));
        }
    });

    // Compute actions based on user status (must be before early returns for hooks ordering)
    const { primaryActions, destructiveActions } = useMemo(() => {
        const status = userProfile?.status;
        switch (status) {
            case 'friend':
                return {
                    primaryActions: [] as { title: string; icon: React.ReactNode; onPress: () => void; loading: boolean }[],
                    destructiveActions: [{
                        title: t('friends.removeFriend'),
                        onPress: handleRemoveFriend,
                        destructive: true,
                    }],
                };
            case 'pending':
                return {
                    primaryActions: [
                        {
                            title: t('friends.acceptRequest'),
                            icon: <Ionicons name="checkmark-circle-outline" size={29} color="#34C759" />,
                            onPress: addFriend,
                            loading: addingFriend,
                        },
                        {
                            title: t('friends.denyRequest'),
                            icon: <Ionicons name="close-circle-outline" size={29} color="#FF3B30" />,
                            onPress: handleRemoveFriend,
                            loading: removingFriend,
                        },
                    ],
                    destructiveActions: [] as { title: string; onPress: () => void; destructive: boolean }[],
                };
            case 'requested':
                return {
                    primaryActions: [] as { title: string; icon: React.ReactNode; onPress: () => void; loading: boolean }[],
                    destructiveActions: [{
                        title: t('friends.cancelRequest'),
                        onPress: handleRemoveFriend,
                        destructive: false,
                    }],
                };
            default:
                return {
                    primaryActions: [{
                        title: t('friends.requestFriendship'),
                        icon: <Ionicons name="person-add-outline" size={29} color="#007AFF" />,
                        onPress: addFriend,
                        loading: addingFriend,
                    }],
                    destructiveActions: [] as { title: string; onPress: () => void; destructive: boolean }[],
                };
        }
    }, [userProfile?.status, handleRemoveFriend, addFriend, addingFriend, removingFriend]);

    // Show action menu (ActionSheetIOS on iOS, ActionMenuModal on Android/Web)
    const handleShowMenu = useCallback(() => {
        if (Platform.OS === 'ios') {
            const options = destructiveActions.map(a => a.title);
            options.push(t('common.cancel'));
            ActionSheetIOS.showActionSheetWithOptions(
                {
                    options,
                    destructiveButtonIndex: destructiveActions.findIndex(a => a.destructive) ?? undefined,
                    cancelButtonIndex: options.length - 1,
                },
                (buttonIndex) => {
                    if (buttonIndex < destructiveActions.length) {
                        destructiveActions[buttonIndex].onPress();
                    }
                }
            );
        } else {
            setMenuVisible(true);
        }
    }, [destructiveActions]);

    // Menu items for ActionMenuModal (Android/Web)
    const menuItems: ActionMenuItem[] = useMemo(() => {
        return destructiveActions.map(a => ({
            label: a.title,
            onPress: a.onPress,
            destructive: a.destructive,
        }));
    }, [destructiveActions]);

    if (isLoading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
            </View>
        );
    }

    if (!userProfile) {
        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{t('errors.userNotFound')}</Text>
            </View>
        );
    }

    const displayName = getDisplayName(userProfile);
    const avatarUrl = userProfile.avatar?.url;

    return (
        <ItemList
            style={{ paddingTop: 0 }}
            refreshControl={
                <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
            }
        >
            {destructiveActions.length > 0 && (
                <Stack.Screen
                    options={{
                        headerRight: () => (
                            <Pressable
                                onPress={handleShowMenu}
                                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                            >
                                <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.header.tint} />
                            </Pressable>
                        ),
                    }}
                />
            )}

            {/* User Info Header */}
            <View style={styles.headerContainer}>
                <View style={styles.profileCard}>
                    <Pressable
                        style={styles.githubIconButton}
                        onPress={() => Linking.openURL(`https://github.com/${userProfile.username}`)}
                    >
                        <Ionicons name="logo-github" size={24} color={theme.colors.text} />
                    </Pressable>

                    <View style={{ marginBottom: 16 }}>
                        <Avatar
                            id={userProfile.id}
                            size={90}
                            imageUrl={avatarUrl}
                            thumbhash={userProfile.avatar?.thumbhash}
                        />
                    </View>

                    <Text style={styles.displayName}>{displayName}</Text>

                    <Text style={styles.username}>@{userProfile.username}</Text>

                    {/* Bio */}
                    {userProfile.bio && (
                        <Text style={styles.bio}>{userProfile.bio}</Text>
                    )}

                    {/* Friend Status Badge */}
                    {userProfile.status === 'friend' && (
                        <View style={styles.statusBadge}>
                            <Ionicons name="checkmark-circle" size={16} color="#34C759" />
                            <Text style={styles.statusText}>{t('friends.alreadyFriends')}</Text>
                        </View>
                    )}
                </View>
            </View>

            {/* Primary Actions (add friend, accept request) - prominent position */}
            {primaryActions.length > 0 && (
                <ItemGroup>
                    {primaryActions.map((action, index) => (
                        <Item
                            key={index}
                            title={action.title}
                            icon={action.icon}
                            onPress={action.onPress}
                            loading={action.loading}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Sessions shared with me by this user */}
            {filteredSharedSessions.length > 0 && (
                <ItemGroup title={t('session.sharing.sharedWithMeSessions')}>
                    {filteredSharedSessions.map((session) => (
                        <SharedSessionItem
                            key={session.id}
                            session={session}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Sessions I shared with this user */}
            {sharedByMeSessions.length > 0 && (
                <ItemGroup title={t('session.sharing.sharedByMeSessions')}>
                    {sharedByMeSessions.map(({ session, accessLevel }) => (
                        <SharedSessionItem
                            key={session.id}
                            session={{ ...session, accessLevel }}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Profile Details */}
            {/* <ItemGroup>
                <Item
                    title={t('profile.firstName')}
                    detail={userProfile.firstName || '-'}
                    showChevron={false}
                />
                <Item
                    title={t('profile.lastName')}
                    detail={userProfile.lastName || '-'}
                    showChevron={false}
                />
                <Item
                    title={t('profile.username')}
                    detail={`@${userProfile.username}`}
                    showChevron={false}
                />
                <Item
                    title={t('profile.status')}
                    detail={t(`friends.status.${userProfile.status}`)}
                    showChevron={false}
                />
            </ItemGroup> */}

            {/* Action Menu for Android/Web */}
            <ActionMenuModal
                visible={menuVisible}
                items={menuItems}
                onClose={() => setMenuVisible(false)}
            />
        </ItemList>
    );
}

function SharedSessionItem({ session, showDivider }: {
    session: Session;
    showDivider?: boolean;
}) {
    const { theme } = useUnistyles();
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const sessionSubtitle = getSessionSubtitle(session);
    const avatarId = getSessionAvatarId(session);
    const router = useRouter();
    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';

    return (
        <Pressable
            onPress={() => router.push(`/session/${session.id}`)}
            style={({ pressed }) => ({
                backgroundColor: pressed && isIOS && !isWeb ? theme.colors.surfacePressedOverlay : 'transparent',
            })}
            android_ripple={!isIOS || isWeb ? {
                color: theme.colors.surfaceRipple,
                borderless: false,
                foreground: true,
            } : undefined}
        >
            <View style={styles.sharedSessionItemInner}>
                <View style={styles.sharedSessionAvatar}>
                    <Avatar
                        id={avatarId}
                        size={48}
                        monochrome={!sessionStatus.isConnected}
                        flavor={session.metadata?.flavor}
                        sessionIcon={session.metadata?.sessionIcon}
                    />
                </View>
                <View style={styles.sharedSessionContent}>
                    <View style={styles.sharedSessionTitleRow}>
                        <Text style={[
                            styles.sharedSessionName,
                            { color: sessionStatus.isConnected ? theme.colors.text : theme.colors.textSecondary }
                        ]} numberOfLines={1}>
                            {sessionName}
                        </Text>
                        <Text style={styles.sharedSessionAccessLevel}>
                            {getAccessLevelLabel(session.accessLevel)}
                        </Text>
                    </View>
                    <Text style={styles.sharedSessionSubtitle} numberOfLines={1}>
                        {sessionSubtitle}
                    </Text>
                    <View style={styles.sharedSessionStatusRow}>
                        <View style={styles.sharedSessionStatusDot}>
                            <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                        </View>
                        <Text style={[styles.sharedSessionStatusText, { color: sessionStatus.statusColor }]}>
                            {sessionStatus.statusText}
                        </Text>
                    </View>
                </View>
            </View>
            {showDivider && (
                <View style={[styles.sharedSessionDivider, { marginLeft: 80 }]} />
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.groupped.background,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.groupped.background,
        padding: 32,
    },
    errorText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    headerContainer: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    profileCard: {
        alignItems: 'center',
        paddingVertical: 32,
        backgroundColor: theme.colors.surface,
        marginTop: 16,
        borderRadius: 12,
        marginHorizontal: 16,
    },
    githubIconButton: {
        position: 'absolute',
        top: 12,
        right: 12,
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 18,
        zIndex: 1,
    },
    displayName: {
        fontSize: 24,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 4,
    },
    username: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
    bio: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        paddingHorizontal: 32,
        marginBottom: 16,
    },
    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(52, 199, 89, 0.1)',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        marginTop: 8,
    },
    statusText: {
        fontSize: 13,
        color: '#34C759',
        marginLeft: 4,
        fontWeight: '500',
    },
    sharedSessionItemInner: {
        height: 76,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    sharedSessionAvatar: {
        width: 48,
        height: 48,
    },
    sharedSessionContent: {
        flex: 1,
        marginLeft: 16,
        justifyContent: 'center',
    },
    sharedSessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sharedSessionName: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sharedSessionAccessLevel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        ...Typography.default(),
    },
    sharedSessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default(),
    },
    sharedSessionStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    sharedSessionStatusDot: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    sharedSessionStatusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    sharedSessionDivider: {
        height: Platform.select({ ios: 0.33, default: 0 }),
        backgroundColor: theme.colors.divider,
    },
}));