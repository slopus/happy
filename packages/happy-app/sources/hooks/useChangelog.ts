import { useCallback, useSyncExternalStore } from 'react';
import {
    getLastViewedVersion,
    setLastViewedVersion,
    getLatestVersion
} from '@/changelog';

/**
 * Shared changelog read-state across all hook instances.
 * Uses useSyncExternalStore so markAsRead in one component
 * immediately updates every other component (e.g. tab bar dot).
 */

const listeners = new Set<() => void>();
let snapshot = computeHasUnread();

function computeHasUnread(): boolean {
    const latestVersion = getLatestVersion();
    const lastViewed = getLastViewedVersion();

    // On first install, mark as read so user doesn't see old entries
    if (lastViewed === 0 && latestVersion > 0) {
        setLastViewedVersion(latestVersion);
        return false;
    }

    return latestVersion > lastViewed;
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function getSnapshot() {
    return snapshot;
}

export function useChangelog() {
    const latestVersion = getLatestVersion();
    const hasUnread = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const markAsRead = useCallback(() => {
        if (latestVersion > 0) {
            setLastViewedVersion(latestVersion);
            snapshot = false;
            listeners.forEach(l => l());
        }
    }, [latestVersion]);

    return {
        hasUnread,
        latestVersion,
        markAsRead
    };
}