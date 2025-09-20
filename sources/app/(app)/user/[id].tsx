import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import { Ionicons } from '@expo/vector-icons';

export default function UserProfileScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { credentials } = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // Load user profile on mount
    useEffect(() => {
        if (!credentials || !id) return;

        const loadUserProfile = async () => {
            setIsLoading(true);
            try {
                const profile = await getUserProfile(credentials, id);
                setUserProfile(profile);
            } catch (error) {
                console.error('Failed to load user profile:', error);
                await Modal.alert(t('errors.failedToLoadProfile'), '', [
                    {
                        text: t('common.ok'),
                        onPress: () => router.back()
                    }
                ]);
            } finally {
                setIsLoading(false);
            }
        };

        loadUserProfile();
    }, [credentials, id]);

    // Add friend / Accept request action
    const [addingFriend, addFriend] = useHappyAction(async () => {
        if (!credentials || !userProfile) return;

        const updatedProfile = await sendFriendRequest(credentials, userProfile.id);
        if (updatedProfile) {
            setUserProfile(updatedProfile);
        } else {
            Modal.alert(t('friends.bothMustHaveGithub'));
        }
    });

    // Remove friend / Cancel request / Reject request action  
    const [removingFriend, handleRemoveFriend] = useHappyAction(async () => {
        if (!credentials || !userProfile) return;

        if (userProfile.status === 'friend') {
            // Removing a friend
            const confirmed = await Modal.confirm(
                t('friends.removeFriend'),
                t('friends.removeFriendConfirm', { name: getDisplayName(userProfile) }),
                { confirmText: t('friends.remove'), destructive: true }
            );

            if (!confirmed) return;
        } else if (userProfile.status === 'requested') {
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
        }
    });

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

    // Determine friend actions based on status
    const getFriendActions = () => {
        switch (userProfile.status) {
            case 'friend':
                return [{
                    title: t('friends.removeFriend'),
                    icon: <Ionicons name="person-remove-outline" size={29} color="#FF3B30" />,
                    onPress: handleRemoveFriend,
                    loading: removingFriend,
                }];
            case 'pending':
                // User has received a friend request
                return [
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
                    }
                ];
            case 'requested':
                // User has sent a friend request
                return [{
                    title: t('friends.cancelRequest'),
                    icon: <Ionicons name="close-outline" size={29} color="#FF9500" />,
                    onPress: handleRemoveFriend,
                    loading: removingFriend,
                }];
            case 'rejected':
            case 'none':
            default:
                return [{
                    title: t('friends.requestFriendship'),
                    icon: <Ionicons name="person-add-outline" size={29} color="#007AFF" />,
                    onPress: addFriend,
                    loading: addingFriend,
                }];
        }
    };

    const friendActions = getFriendActions();

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* User Info Header */}
            <View style={styles.headerContainer}>
                <View style={styles.profileCard}>
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

            {/* Actions */}
            <ItemGroup>
                {friendActions.map((action, index) => (
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

            {/* GitHub Link */}

            <ItemGroup>
                <Item
                    title={t('settings.github')}
                    detail={`@${userProfile.username}`} 
                    icon={<Ionicons name="logo-github" size={29} color={theme.colors.text} />}
                    onPress={async () => {
                        const url = `https://github.com/${userProfile.username}`;
                        const supported = await Linking.canOpenURL(url);
                        if (supported) {
                            await Linking.openURL(url);
                        }
                    }}
                />
            </ItemGroup>

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
        </ItemList>
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
}));