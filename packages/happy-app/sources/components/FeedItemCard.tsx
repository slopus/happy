import * as React from 'react';
import { View, Platform, Pressable } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { FeedItem } from '@/sync/feedTypes';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { useUser, storage } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { Avatar } from './Avatar';
import { Item } from './Item';
import { Text } from './StyledText';
import { deleteFeedItem } from '@/sync/apiFeed';
import { Typography } from '@/constants/Typography';

const SWIPE_ACTION_WIDTH = 80;

interface FeedItemCardProps {
    item: FeedItem;
}

export const FeedItemCard = React.memo(({ item }: FeedItemCardProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { credentials } = useAuth();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web';

    // Get user profile from global users cache for friend-related items
    // User MUST exist for friend-related items or they would have been filtered out
    const user = useUser(
        (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')
            ? item.body.uid
            : undefined
    );

    const getTimeAgo = (timestamp: number) => {
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return t('time.justNow');
        if (minutes < 60) return t('time.minutesAgo', { count: minutes });
        if (hours < 24) return t('time.hoursAgo', { count: hours });
        return t('sessionHistory.daysAgo', { count: days });
    };

    const handleDelete = React.useCallback(() => {
        swipeableRef.current?.close();
        // Optimistic removal
        storage.getState().removeFeedItem(item.id);
        // Fire and forget server deletion
        if (credentials) {
            deleteFeedItem(credentials, item.id).catch(console.error);
        }
    }, [item.id, credentials]);

    const renderContent = () => {
        switch (item.body.kind) {
            case 'friend_request': {
                const avatarElement = user!.avatar ? (
                    <Avatar
                        id={user!.id}
                        imageUrl={user!.avatar.url}
                        size={40}
                    />
                ) : (
                    <Ionicons name="person" size={20} color={theme.colors.textSecondary} />
                );

                return (
                    <Item
                        title={t('feed.friendRequestFrom', { name: user!.firstName || user!.username })}
                        subtitle={getTimeAgo(item.createdAt)}
                        leftElement={avatarElement}
                        iconContainerStyle={{ marginRight: 16 }}
                        onPress={() => router.push(`/user/${user!.id}`)}
                        showChevron={true}
                    />
                );
            }

            case 'friend_accepted': {
                const avatarElement = user!.avatar ? (
                    <Avatar
                        id={user!.id}
                        imageUrl={user!.avatar.url}
                        size={40}
                    />
                ) : (
                    <Ionicons name="checkmark-circle" size={20} color={theme.colors.status.connected} />
                );

                return (
                    <Item
                        title={t('feed.friendAccepted', { name: user!.firstName || user!.username })}
                        subtitle={getTimeAgo(item.createdAt)}
                        leftElement={avatarElement}
                        iconContainerStyle={{ marginRight: 16 }}
                        onPress={() => router.push(`/user/${user!.id}`)}
                        showChevron={true}
                    />
                );
            }

            case 'text':
                return (
                    <Item
                        title={item.body.text}
                        subtitle={getTimeAgo(item.createdAt)}
                        icon={<Ionicons name="information-circle" size={20} color={theme.colors.textSecondary} />}
                        iconContainerStyle={{ marginRight: 16 }}
                        showChevron={false}
                    />
                );

            default:
                return null;
        }
    };

    if (!swipeEnabled) {
        return renderContent();
    }

    const renderRightActions = () => (
        <Pressable onPress={handleDelete} style={styles.swipeAction}>
            <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText}>{t('common.delete')}</Text>
        </Pressable>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={renderRightActions}
            overshootRight={false}
            friction={2}
            rightThreshold={40}
        >
            <View style={{ backgroundColor: theme.colors.surface }}>
                {renderContent()}
            </View>
        </Swipeable>
    );
});

const styles = StyleSheet.create((theme) => ({
    swipeAction: {
        width: SWIPE_ACTION_WIDTH,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: '#FFFFFF',
        ...Typography.default('semiBold'),
    },
}));
