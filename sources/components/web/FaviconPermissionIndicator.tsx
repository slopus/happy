import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { useSessionStatus } from '@/utils/sessionUtils';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    // Only run on web platform
    console.log('[FaviconPermissionIndicator] Platform.OS:', Platform.OS);
    if (Platform.OS !== 'web') {
        return null;
    }

    React.useEffect(() => {
        console.log('[FaviconPermissionIndicator] Component mounted');
        
        // Check if we're in a browser environment
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            console.log('[FaviconPermissionIndicator] Not in browser environment, skipping');
            return;
        }
        
        let mounted = true;
        let checkInterval: ReturnType<typeof setInterval>;

        const checkPermissions = () => {
            if (!mounted) return;

            const state = storage.getState();
            const sessions = state.sessions;
            console.log('[FaviconPermissionIndicator] Checking permissions, sessions:', Object.keys(sessions).length);
            
            let hasOnlineSessionWithPermissions = false;

            // Check each session
            Object.values(sessions).forEach(session => {
                // Skip if we already found one
                if (hasOnlineSessionWithPermissions) return;

                // Check if session is online
                const isOnline = session.presence === 'online' || 
                    (typeof session.presence === 'number' && 
                     session.presence > Date.now() - 30000); // 30 second timeout

                if (isOnline) {
                    // Check if session has pending permissions
                    const hasPermissions = session.agentState?.requests && 
                        Object.keys(session.agentState.requests).length > 0;

                    console.log('[FaviconPermissionIndicator] Session', session.id, 'online:', isOnline, 'hasPermissions:', hasPermissions, 'requests:', session.agentState?.requests);

                    if (hasPermissions) {
                        hasOnlineSessionWithPermissions = true;
                    }
                }
            });

            // Update favicon based on permission state
            console.log('[FaviconPermissionIndicator] Has online session with permissions:', hasOnlineSessionWithPermissions);
            if (hasOnlineSessionWithPermissions) {
                console.log('[FaviconPermissionIndicator] Updating favicon with notification');
                updateFaviconWithNotification();
            } else {
                console.log('[FaviconPermissionIndicator] Resetting favicon');
                resetFavicon();
            }
        };

        // Initial check
        checkPermissions();

        // Subscribe to store changes
        const unsubscribe = storage.subscribe(() => {
            checkPermissions();
        });

        // Also check periodically to handle presence timeout changes
        checkInterval = setInterval(checkPermissions, 5000); // Check every 5 seconds

        return () => {
            mounted = false;
            unsubscribe();
            clearInterval(checkInterval);
            // Reset favicon when component unmounts
            resetFavicon();
        };
    }, []);

    return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';