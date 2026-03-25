import React from 'react';
import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { storage, useAnyOnlineSyncSessionHasPendingPermissions } from '@/sync/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const onlineSessionIds = storage(useShallow((state) => (
        Object.values(state.sessions)
            .filter((session) => session.presence === 'online')
            .map((session) => session.id)
    )));
    const hasOnlineSessionWithPermissions = useAnyOnlineSyncSessionHasPendingPermissions(onlineSessionIds);

    React.useLayoutEffect(() => {
        if (hasOnlineSessionWithPermissions) {
            updateFaviconWithNotification();
        } else {
            resetFavicon();
        }
    }, [hasOnlineSessionWithPermissions]);

    React.useLayoutEffect(() => {
        return () => {
            resetFavicon();
        };
    }, []);

    return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';
