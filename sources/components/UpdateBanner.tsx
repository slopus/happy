import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { useUpdates } from '@/hooks/useUpdates';
import { useChangelog } from '@/hooks/useChangelog';
import { useRouter } from 'expo-router';
import { t } from '@/text';

export const UpdateBanner = React.memo(() => {
    const { theme } = useUnistyles();
    const { updateAvailable, reloadApp } = useUpdates();
    const { hasUnread, isInitialized, markAsRead } = useChangelog();
    const router = useRouter();

    // Show update banner if app update is available
    if (updateAvailable) {
        return (
            <ItemGroup>
                <Item
                    title={t('updateBanner.updateAvailable')}
                    subtitle={t('updateBanner.pressToApply')}
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
                    title={t('updateBanner.whatsNew')}
                    subtitle={t('updateBanner.seeLatest')}
                    icon={<Ionicons name="sparkles-outline" size={28} color={theme.colors.text} />}
                    showChevron={true}
                    onPress={() => {
                        router.push('/changelog');
                        setTimeout(() => {
                            markAsRead();
                        }, 1000);
                    }}
                />
            </ItemGroup>
        );
    }

    return null;
});
