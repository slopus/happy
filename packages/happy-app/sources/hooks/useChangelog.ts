import { useState, useCallback } from 'react';
import { MMKV } from 'react-native-mmkv';
import {
    getLastViewedTitle,
    setLastViewedTitle,
    getLatestTitle
} from '@/changelog';

const mmkv = new MMKV();

export function useChangelog() {
    const latestTitle = getLatestTitle();

    const [hasUnread, setHasUnread] = useState(() => {
        const lastViewed = getLastViewedTitle();

        // On first install (no old or new key), mark as read
        // If old version key exists but new title key doesn't, this is a
        // migration — show the banner
        if (!lastViewed && latestTitle) {
            const hadOldKey = mmkv.contains('changelog-last-viewed-version');
            if (!hadOldKey) {
                setLastViewedTitle(latestTitle);
                return false;
            }
            // Migration from old system — treat as unread
            return true;
        }

        return latestTitle !== lastViewed;
    });

    const markAsRead = useCallback(() => {
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
            setHasUnread(false);
        }
    }, [latestTitle]);

    return {
        hasUnread,
        latestTitle,
        markAsRead
    };
}
