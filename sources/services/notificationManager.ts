import * as Notifications from 'expo-notifications';
import { Platform, AppState } from 'react-native';
import { Session } from '@/sync/storageTypes';
import { generateNotificationContent, NotificationType } from './notificationContent';

/**
 * Configure notification handler
 * This determines how notifications are displayed when the app is in foreground
 */
Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        return {
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: false,
            shouldSetBadge: false,
        };
    },
});

/**
 * Check if we should send notifications
 * Only send when app is in background
 */
function shouldSendNotification(): boolean {
    // Don't send notifications when app is in foreground
    if (AppState.currentState === 'active') {
        return false;
    }

    return true;
}

/**
 * Send a notification about a session state change
 *
 * @param session - The session that triggered the notification
 * @param type - Type of notification
 * @param options - Additional options
 */
export async function sendSessionNotification(
    session: Session,
    type: NotificationType,
    options?: {
        permissionName?: string;
        permissionReason?: string;
        customMessage?: string;
    }
): Promise<void> {
    // Check if we should send notification
    if (!shouldSendNotification()) {
        console.log('[Notification] Skipping notification - app is in foreground');
        return;
    }

    try {
        // Generate notification content
        const { title, body } = generateNotificationContent({
            session,
            type,
            permissionName: options?.permissionName,
            permissionReason: options?.permissionReason,
            customMessage: options?.customMessage,
        });

        // Schedule notification
        await Notifications.scheduleNotificationAsync({
            content: {
                title,
                body,
                data: {
                    sessionId: session.id,
                    type,
                },
            },
            trigger: null, // Show immediately
        });

        console.log(`[Notification] Sent ${type} notification for session ${session.id.slice(0, 8)}`);
    } catch (error) {
        console.error('[Notification] Failed to send notification:', error);
    }
}

/**
 * Send notification when session needs permission
 */
export async function notifyPermissionRequired(
    session: Session,
    permissionName: string,
    permissionReason?: string
): Promise<void> {
    await sendSessionNotification(session, 'permission', {
        permissionName,
        permissionReason,
    });
}

/**
 * Send notification when session is waiting for user input
 */
export async function notifyInputRequired(
    session: Session,
    message?: string
): Promise<void> {
    await sendSessionNotification(session, 'input', {
        customMessage: message,
    });
}

/**
 * Send notification when session completes a task
 */
export async function notifyTaskCompleted(
    session: Session,
    message?: string
): Promise<void> {
    await sendSessionNotification(session, 'completion', {
        customMessage: message,
    });
}

/**
 * Send notification when session encounters an error
 */
export async function notifyError(
    session: Session,
    errorMessage?: string
): Promise<void> {
    await sendSessionNotification(session, 'error', {
        customMessage: errorMessage,
    });
}

/**
 * Request notification permissions
 * Should be called during app initialization
 */
export async function requestNotificationPermissions(): Promise<boolean> {
    try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            finalStatus = status;
        }

        if (finalStatus !== 'granted') {
            console.log('[Notification] Permission not granted');
            return false;
        }

        console.log('[Notification] Permission granted');
        return true;
    } catch (error) {
        console.error('[Notification] Failed to request permissions:', error);
        return false;
    }
}
