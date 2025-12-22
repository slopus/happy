import { useState, useCallback } from 'react';
import {
    getLastViewedVersion,
    setLastViewedVersion,
    getLatestVersion
} from '@/changelog';

export function useChangelog() {
    // MMKV reads are synchronous - no need for useEffect
    const latestVersion = getLatestVersion();

    const [hasUnread, setHasUnread] = useState(() => {
        const lastViewed = getLastViewedVersion();

        // On first install, mark as read so user doesn't see old entries
        if (lastViewed === 0 && latestVersion > 0) {
            setLastViewedVersion(latestVersion);
            return false;
        }

        return latestVersion > lastViewed;
    });

    const markAsRead = useCallback(() => {
        if (latestVersion > 0) {
            setLastViewedVersion(latestVersion);
            setHasUnread(false);
        }
    }, [latestVersion]);

    return {
        hasUnread,
        latestVersion,
        markAsRead
    };
}