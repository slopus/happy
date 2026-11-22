import { useCallback, useEffect, useState } from 'react';
import { MMKV } from '@/persistence/deviceStorage';
import {
    getLastViewedTitle,
    setLastViewedTitle,
    getLatestTitle
} from '@/changelog';

const mmkv = new MMKV();

export function useChangelog() {
    const latestTitle = getLatestTitle();
    const [hasUnread, setHasUnread] = useState(false);

    useEffect(() => {
        if (!latestTitle) return;

        const lastViewed = getLastViewedTitle();

        if (!lastViewed) {
            const hadOldKey = mmkv.contains('changelog-last-viewed-version');
            if (!hadOldKey) {
                setLastViewedTitle(latestTitle);
                setHasUnread(false);
                return;
            }
            setHasUnread(true);
            return;
        }

        setHasUnread(latestTitle !== lastViewed);
    }, [latestTitle]);

    const markAsRead = useCallback(() => {
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
            setHasUnread(false);
        }
    }, [latestTitle]);

    return {
        hasUnread,
        latestTitle,
        loading: false,
        markAsRead
    };
}
