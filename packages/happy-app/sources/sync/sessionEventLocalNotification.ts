import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { log } from '@/log';
import type { ApiEphemeralSessionEventUpdate } from './apiTypes';
import type { SyncCurrentPushTokenResult } from './pushRegistration';

export function getInitialSessionEventLocalNotificationsEnabled(): boolean {
    return Platform.OS !== 'web';
}

export function shouldEnableSessionEventLocalNotifications(result: SyncCurrentPushTokenResult): boolean {
    return Platform.OS !== 'web' && result.permission.granted && !result.registered;
}

export async function maybeScheduleSessionEventLocalNotification(
    event: ApiEphemeralSessionEventUpdate,
    options: { enabled: boolean },
): Promise<boolean> {
    if (!options.enabled || Platform.OS === 'web') {
        return false;
    }

    try {
        await Notifications.scheduleNotificationAsync({
            content: {
                title: event.title,
                body: event.body,
                data: {
                    kind: event.kind,
                    sessionId: event.sessionId,
                    timestamp: event.timestamp,
                    url: `/session/${encodeURIComponent(event.sessionId)}`,
                    source: 'session-event-local-fallback',
                },
                sound: true,
                ...(Platform.OS === 'android' ? { badge: 1 } : {}),
            },
            trigger: {
                channelId: 'messages',
            },
        });
        return true;
    } catch (error) {
        log.log(`Failed to schedule session-event local notification: ${error}`);
        return false;
    }
}
