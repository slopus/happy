import { useEffect, useState } from 'react';
import { 
    getLastViewedVersion, 
    setLastViewedVersion, 
    getLatestVersion, 
    hasUnreadChangelog 
} from '@/changelog';

export function useChangelog() {
    const [isInitialized, setIsInitialized] = useState(false);
    const [hasUnread, setHasUnread] = useState(false);
    const [latestVersion, setLatestVersionState] = useState(0);

    useEffect(() => {
        const initialize = () => {
            try {
                const latest = getLatestVersion();
                const lastViewed = getLastViewedVersion();
                
                // On first install, set the last viewed version to current version
                // so user doesn't see old changelog entries as unread
                if (lastViewed === 0 && latest > 0) {
                    setLastViewedVersion(latest);
                }
                
                setLatestVersionState(latest);
                setHasUnread(hasUnreadChangelog(latest));
                setIsInitialized(true);
            } catch (error) {
                console.warn('Failed to initialize changelog:', error);
                setIsInitialized(true);
            }
        };

        initialize();
    }, []);

    const markAsRead = () => {
        if (latestVersion > 0) {
            setLastViewedVersion(latestVersion);
            setHasUnread(false);
        }
    };

    return {
        isInitialized,
        hasUnread,
        latestVersion,
        markAsRead
    };
}