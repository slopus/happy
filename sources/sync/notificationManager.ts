import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { log } from '@/log';

/**
 * NotificationManager
 *
 * Manages push notification lifecycle, including tracking and dismissal.
 * Solves the bug where notifications persist in the tray even after the user
 * manually opens the app and views the relevant session.
 */
export class NotificationManager {
  // In-memory tracking of notification IDs per session
  private notificationMap: Map<string, Set<string>> = new Map();

  /**
   * Track a notification for a specific session
   * Called when a push notification is received
   */
  trackNotification(sessionId: string, notificationId: string): void {
    if (!sessionId || !notificationId) {
      log.log('⚠️ NotificationManager: Invalid sessionId or notificationId');
      return;
    }

    let sessionNotifications = this.notificationMap.get(sessionId);
    if (!sessionNotifications) {
      sessionNotifications = new Set<string>();
      this.notificationMap.set(sessionId, sessionNotifications);
    }

    sessionNotifications.add(notificationId);
    log.log(`📬 NotificationManager: Tracked notification ${notificationId} for session ${sessionId}`);
  }

  /**
   * Get all pending notifications from the system
   */
  async getPendingNotifications(): Promise<Array<{ id: string; sessionId?: string; messageId?: string }>> {
    // Only supported on mobile platforms
    if (Platform.OS === 'web') {
      return [];
    }

    try {
      const presented = await Notifications.getPresentedNotificationsAsync();
      return presented.map(notification => ({
        id: notification.request.identifier,
        sessionId: notification.request.content.data?.sessionId as string | undefined,
        messageId: notification.request.content.data?.messageId as string | undefined,
      }));
    } catch (error) {
      log.log(`❌ NotificationManager: Error getting pending notifications: ${error}`);
      return [];
    }
  }

  /**
   * Dismiss all notifications for a specific session
   * Called when a session becomes visible or app becomes active with session open
   */
  async dismissNotificationsForSession(sessionId: string): Promise<void> {
    // Only supported on mobile platforms
    if (Platform.OS === 'web') {
      return;
    }

    if (!sessionId) {
      log.log('⚠️ NotificationManager: Cannot dismiss - invalid sessionId');
      return;
    }

    try {
      log.log(`🔔 NotificationManager: Dismissing notifications for session ${sessionId}`);

      // Get all currently presented notifications
      const presented = await Notifications.getPresentedNotificationsAsync();

      let dismissedCount = 0;
      for (const notification of presented) {
        const data = notification.request.content.data;
        const notificationSessionId = data?.sessionId;

        // Check if this notification belongs to the session
        if (notificationSessionId === sessionId) {
          const notificationId = notification.request.identifier;
          try {
            await Notifications.dismissNotificationAsync(notificationId);
            dismissedCount++;

            // Remove from our tracking
            this.removeNotificationFromTracking(sessionId, notificationId);

            log.log(`✅ NotificationManager: Dismissed notification ${notificationId}`);
          } catch (dismissError) {
            log.log(`❌ NotificationManager: Failed to dismiss ${notificationId}: ${dismissError}`);
          }
        }
      }

      log.log(`🔔 NotificationManager: Dismissed ${dismissedCount} notification(s) for session ${sessionId}`);
    } catch (error) {
      log.log(`❌ NotificationManager: Error dismissing notifications for session ${sessionId}: ${error}`);
      // Don't throw - failures should be logged but not crash the app
    }
  }

  /**
   * Dismiss notifications for a specific message
   * Called when a message scrolls into view
   */
  async dismissNotificationsForMessage(sessionId: string, messageId: string): Promise<void> {
    // Only supported on mobile platforms
    if (Platform.OS === 'web') {
      return;
    }

    if (!sessionId || !messageId) {
      log.log('⚠️ NotificationManager: Cannot dismiss - invalid sessionId or messageId');
      return;
    }

    try {
      log.log(`🔔 NotificationManager: Dismissing notifications for message ${messageId} in session ${sessionId}`);

      // Get all currently presented notifications
      const presented = await Notifications.getPresentedNotificationsAsync();

      let dismissedCount = 0;
      for (const notification of presented) {
        const data = notification.request.content.data;
        const notificationSessionId = data?.sessionId;
        const notificationMessageId = data?.messageId;

        // Check if this notification belongs to the specific message
        if (notificationSessionId === sessionId && notificationMessageId === messageId) {
          const notificationId = notification.request.identifier;
          try {
            await Notifications.dismissNotificationAsync(notificationId);
            dismissedCount++;

            // Remove from our tracking
            this.removeNotificationFromTracking(sessionId, notificationId);

            log.log(`✅ NotificationManager: Dismissed notification ${notificationId} for message ${messageId}`);
          } catch (dismissError) {
            log.log(`❌ NotificationManager: Failed to dismiss ${notificationId}: ${dismissError}`);
          }
        }
      }

      log.log(`🔔 NotificationManager: Dismissed ${dismissedCount} notification(s) for message ${messageId}`);
    } catch (error) {
      log.log(`❌ NotificationManager: Error dismissing notifications for message ${messageId}: ${error}`);
      // Don't throw - failures should be logged but not crash the app
    }
  }

  /**
   * Dismiss notification for a specific permission
   * Called when a permission is granted - handles the permission notification bug
   *
   * This solves the bug where permission notifications remain in the tray
   * even after the user manually opens the app and grants the permission.
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
   * Remove a notification from our internal tracking
   */
  private removeNotificationFromTracking(sessionId: string, notificationId: string): void {
    const sessionNotifications = this.notificationMap.get(sessionId);
    if (sessionNotifications) {
      sessionNotifications.delete(notificationId);

      // Clean up empty sets
      if (sessionNotifications.size === 0) {
        this.notificationMap.delete(sessionId);
      }
    }
  }

  /**
   * Clear all tracking (useful for testing or logout)
   */
  clearAllTracking(): void {
    this.notificationMap.clear();
    log.log('🧹 NotificationManager: Cleared all notification tracking');
  }
}

// Global singleton instance
export const notificationManager = new NotificationManager();
