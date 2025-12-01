import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { log } from '@/log';

/**
 * NotificationManager
 *
 * Handles specific notification dismissal for user actions.
 * Solves bugs where notifications remain in the tray even after
 * the user manually opens the app and handles the event.
 */
export class NotificationManager {
  /**
   * Dismiss notification for a specific permission
   * Called when a permission is granted or denied
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

  /**
   * Dismiss notification for a friend request
   * Called when a friend request is accepted, rejected, or cancelled
   *
   * @param userId - The user ID of the friend request (either sender or receiver)
   * @param requestType - 'incoming' for received requests, 'outgoing' for sent requests
   */
  async dismissNotificationForFriendRequest(userId: string, requestType: 'incoming' | 'outgoing'): Promise<void> {
    // Only supported on mobile platforms
    if (Platform.OS === 'web') {
      return;
    }

    if (!userId) {
      log.log('⚠️ NotificationManager: Cannot dismiss - invalid userId');
      return;
    }

    try {
      log.log(`🔔 NotificationManager: Dismissing ${requestType} friend request notification for user ${userId}`);

      // Get all currently presented notifications
      const presented = await Notifications.getPresentedNotificationsAsync();

      let dismissedCount = 0;
      for (const notification of presented) {
        const data = notification.request.content.data;
        const notificationUserId = data?.userId;
        const notificationType = data?.type;
        const notificationRequestType = data?.requestType;

        // Match by userId, type='friend_request', and requestType
        if (
          notificationUserId === userId &&
          notificationType === 'friend_request' &&
          notificationRequestType === requestType
        ) {
          const notificationId = notification.request.identifier;
          try {
            await Notifications.dismissNotificationAsync(notificationId);
            dismissedCount++;
            log.log(`✅ NotificationManager: Dismissed friend request notification ${notificationId}`);
          } catch (dismissError) {
            log.log(`❌ NotificationManager: Failed to dismiss ${notificationId}: ${dismissError}`);
          }
        }
      }

      log.log(`🔔 NotificationManager: Dismissed ${dismissedCount} ${requestType} friend request notification(s) for user ${userId}`);
    } catch (error) {
      log.log(`❌ NotificationManager: Error dismissing friend request notification: ${error}`);
      // Don't throw - failures should be logged but not crash the app
    }
  }
}

// Global singleton instance
export const notificationManager = new NotificationManager();
