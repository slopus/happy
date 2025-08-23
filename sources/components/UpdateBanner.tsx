import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { useUpdates } from '@/hooks/useUpdates';

export const UpdateBanner = React.memo(() => {
    const { theme } = useUnistyles();
    const { updateAvailable, reloadApp } = useUpdates();

    if (!updateAvailable) {
        return null;
    }

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
});