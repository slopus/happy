import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { useUpdates } from '@/hooks/useUpdates';
import { useChangelog } from '@/hooks/useChangelog';
import { useRouter } from 'expo-router';

export const UpdateBanner = React.memo(() => {
    const { theme } = useUnistyles();
    const { updateAvailable, reloadApp } = useUpdates();
    const { hasUnread, isInitialized } = useChangelog();
    const router = useRouter();

    // Show update banner if app update is available
    if (updateAvailable) {
        return (
            <ItemGroup>
                <Item
                    title="Update available"
                    subtitle="Press to apply the update"
                    icon={<Ionicons name="download-outline" size={28} color={theme.colors.success} />}
                    showChevron={false}
                    onPress={reloadApp}
                />
            </ItemGroup>
        );
    }

    // Show changelog banner if there are unread changelog entries and changelog is initialized
    if (isInitialized && hasUnread) {
        return (
            <ItemGroup>
                <Item
                    title="What's new"
                    subtitle="See the latest updates and improvements"
                    icon={<Ionicons name="sparkles-outline" size={28} color={theme.colors.text} />}
                    showChevron={true}
                    onPress={() => router.push('/changelog')}
                />
            </ItemGroup>
        );
    }

    return null;
});