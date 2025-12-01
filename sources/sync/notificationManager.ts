import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { log } from '@/log';

/**
 * NotificationManager
 *
 * Handles permission notification dismissal.
 * Solves the bug where permission notifications remain in the tray
 * even after the user manually opens the app and grants the permission.
 */
export class NotificationManager {
  /**
   * Dismiss notification for a specific permission
   * Called when a permission is granted
   *
   * @param sessionId - The session ID where the permission was granted
   * @param permissionId - The specific permission ID (permission.id from the payload)
   */
  async dismissNotificationForPermission(sessionId: string, permissionId: string): Promise<void> {
    // Only supported on mobile platforms
    if (Platform.OS === 'web') {
      return;
    }

    if (!sessionId || !permissionId) {
      log.log('⚠️ NotificationManager: Cannot dismiss - invalid sessionId or permissionId');
      return;
    }

    try {
      log.log(`🔔 NotificationManager: Dismissing notification for permission ${permissionId} in session ${sessionId}`);

      // Get all currently presented notifications
      const presented = await Notifications.getPresentedNotificationsAsync();

      let dismissedCount = 0;
      for (const notification of presented) {
        const data = notification.request.content.data;
        const notificationSessionId = data?.sessionId;
        const notificationPermissionId = data?.permissionId;

        // Only dismiss notifications that match BOTH sessionId AND permissionId
        // This ensures we only dismiss the specific permission that was granted
        if (notificationSessionId === sessionId && notificationPermissionId === permissionId) {
          const notificationId = notification.request.identifier;
          try {
            await Notifications.dismissNotificationAsync(notificationId);
            dismissedCount++;
            log.log(`✅ NotificationManager: Dismissed permission notification ${notificationId}`);
          } catch (dismissError) {
            log.log(`❌ NotificationManager: Failed to dismiss ${notificationId}: ${dismissError}`);
          }
        }
      }

      log.log(`🔔 NotificationManager: Dismissed ${dismissedCount} permission notification(s) for ${permissionId}`);
    } catch (error) {
      log.log(`❌ NotificationManager: Error dismissing permission notification: ${error}`);
      // Don't throw - failures should be logged but not crash the app
    }
  }
}

// Global singleton instance
export const notificationManager = new NotificationManager();
