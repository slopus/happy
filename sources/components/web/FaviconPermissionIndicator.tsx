import React from 'react';
import { Platform } from 'react-native';

import { storage } from '@/sync/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
  // Move hooks before early return
  const hasOnlineSessionWithPermissions = storage((state) => {
    return Object.values(state.sessions).some(session => {
      // Use centralized presence logic - only "online" sessions matter
      const isOnline = session.presence === 'online';

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

  if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';