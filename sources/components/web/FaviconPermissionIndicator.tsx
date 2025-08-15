import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const hasOnlineSessionWithPermissions = storage((state) => {
        const now = Date.now();
        const threshold = now - 30000;
        
        return Object.values(state.sessions).some(session => {
            const isOnline = session.presence === 'online' || 
                (typeof session.presence === 'number' && session.presence > threshold);

            const hasPermissions = session.agentState?.requests && 
                Object.keys(session.agentState.requests).length > 0;

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