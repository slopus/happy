import * as React from 'react';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { log } from '@/log';
import { storage } from '@/sync/storage';
import { getSessionAttentionBadgeCount } from '@/utils/sessionAttentionBadge';

/** Keeps supported Android launchers in sync with sessions needing attention. */
export const AndroidAppIconBadge = React.memo(() => {
    const isDataReady = storage((state) => state.isDataReady);
    const badgeCount = storage((state) => getSessionAttentionBadgeCount(
        state.sessions,
        state.unreadSessionIds,
    ));

    React.useEffect(() => {
        if (Platform.OS !== 'android' || !isDataReady) return;

        let cancelled = false;
        const applyBadgeCount = async () => {
            try {
                if (badgeCount === 0) {
                    // Expo Notifications 55 clears every Android notification when setting 0.
                    // Preserve presented notifications and let the launcher derive their badge.
                    const presentedNotifications = await Notifications.getPresentedNotificationsAsync();
                    if (cancelled || presentedNotifications.length > 0) return;
                }
                if (cancelled) return;
                await Notifications.setBadgeCountAsync(badgeCount);
            } catch (error: unknown) {
                log.log(`Failed to update Android app icon badge: ${error}`);
            }
        };

        void applyBadgeCount();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') void applyBadgeCount();
        });

        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, [badgeCount, isDataReady]);

    return null;
});

AndroidAppIconBadge.displayName = 'AndroidAppIconBadge';
