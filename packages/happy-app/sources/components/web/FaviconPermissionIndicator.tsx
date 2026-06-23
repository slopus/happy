import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';
import { hasPendingPermissionRequests } from '@/utils/permissionRequests';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const hasOnlineSessionWithPermissions = storage((state) => {
        return Object.values(state.sessions).some(session => {
            if (!session) return false;
            // Use centralized presence logic - only "online" sessions matter
            const isOnline = session.presence === 'online';

            const hasPermissions = hasPendingPermissionRequests(session.agentState);

            return isOnline && hasPermissions;
        });
    });

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
