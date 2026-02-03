import * as React from 'react';
import { FeedItem } from '@/sync/feedTypes';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { useUser } from '@/sync/storage';
import { Avatar } from './Avatar';
import { Item } from './Item';
import { useUnistyles } from 'react-native-unistyles';

interface FeedItemCardProps {
    item: FeedItem;
}

export const FeedItemCard = React.memo(({ item }: FeedItemCardProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    
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
                    showChevron={false}
                />
            );
            
        default:
            return null;
    }
});