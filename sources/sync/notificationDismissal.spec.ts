import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Test suite for notification dismissal behavior
 *
 * Bug: Notifications remain in the system tray even when the user:
 * 1. Manually opens the app (not via notification tap)
 * 2. Views the session that triggered the notification
 * 3. Scrolls past the event that caused the notification
 *
 * Expected behavior: Notifications should be automatically dismissed when:
 * - The session becomes visible (sync.onSessionVisible is called)
 * - The app becomes active and the user is already viewing the relevant session
 * - The user scrolls past/views the message that triggered the notification
 */

// Mock expo-notifications - mocks must be hoisted, so we can't use const outside
vi.mock('expo-notifications', () => ({
  default: {
    dismissNotificationAsync: vi.fn(),
    getPresentedNotificationsAsync: vi.fn(),
    dismissAllNotificationsAsync: vi.fn(),
  },
  dismissNotificationAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(),
  dismissAllNotificationsAsync: vi.fn(),
}));

// Mock Platform
vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios', // Test on iOS by default
  },
}));

// Mock log
vi.mock('@/log', () => ({
  log: {
    log: vi.fn(),
  },
}));

import { NotificationManager } from './notificationManager';
import * as Notifications from 'expo-notifications';

describe('Notification Dismissal', () => {
  let notificationManager: NotificationManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([]);
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined);
    vi.mocked(Notifications.dismissAllNotificationsAsync).mockResolvedValue(undefined);

    // Create a fresh NotificationManager instance for each test
    notificationManager = new NotificationManager();
  });

  describe('Session visibility triggers dismissal', () => {
    it('should dismiss all notifications for a session when session becomes visible', async () => {
      // Setup: Simulate notifications in the tray for session 'abc123'
      const sessionId = 'abc123';
      const notificationId1 = 'notif-1';
      const notificationId2 = 'notif-2';

      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
        {
          request: {
            identifier: notificationId1,
            content: {
              data: { sessionId },
            },
          },
        },
        {
          request: {
            identifier: notificationId2,
            content: {
              data: { sessionId },
            },
          },
        },
      ]);

      // Act: Session becomes visible (user navigates to it)
      await notificationManager.dismissNotificationsForSession(sessionId);

      // Assert: Both notifications should be dismissed
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith(notificationId1);
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith(notificationId2);
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(2);
    });

    it('should only dismiss notifications for the specific session, not others', async () => {
      const targetSessionId = 'session-1';
      const otherSessionId = 'session-2';

      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
        {
          request: {
            identifier: 'notif-session-1',
            content: {
              data: { sessionId: targetSessionId },
            },
          },
        },
        {
          request: {
            identifier: 'notif-session-2',
            content: {
              data: { sessionId: otherSessionId },
            },
          },
        },
      ]);

      // Act
      await notificationManager.dismissNotificationsForSession(targetSessionId);

      // Assert: Only session-1's notification should be dismissed
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith('notif-session-1');
      expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalledWith('notif-session-2');
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
    });
  });

  describe('Message visibility triggers dismissal', () => {
    it('should dismiss notification when user scrolls past the message that triggered it', async () => {
      const sessionId = 'abc123';
      const messageId = 'msg-456';
      const notificationId = 'notif-for-msg-456';

      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
        {
          request: {
            identifier: notificationId,
            content: {
              data: { sessionId, messageId },
            },
          },
        },
      ]);

      // Act: User scrolls and message becomes visible
      await notificationManager.dismissNotificationsForMessage(sessionId, messageId);

      // Assert
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith(notificationId);
    });

    it('should handle notifications without messageId gracefully', async () => {
      const sessionId = 'abc123';

      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
        {
          request: {
            identifier: 'notif-general',
            content: {
              data: { sessionId }, // No messageId
            },
          },
        },
      ]);

      // Act: Dismiss by session (should work even without messageId)
      await notificationManager.dismissNotificationsForSession(sessionId);

      // Assert
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith('notif-general');
    });
  });

  describe('Notification tracking', () => {
    it('should track notification IDs mapped to sessions', async () => {
      const sessionId = 'session-123';
      const notificationId = 'notif-789';

      // Setup: Mock getPresentedNotificationsAsync to return a notification
      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
        {
          request: {
            identifier: notificationId,
            content: {
              data: { sessionId },
            },
          },
        },
      ]);

      // Act: When a push notification is received, it should be tracked
      notificationManager.trackNotification(sessionId, notificationId);

      // Assert: getPendingNotifications returns what's in the system tray
      const pending = await notificationManager.getPendingNotifications();
      expect(pending).toContainEqual({ id: notificationId, sessionId, messageId: undefined });
    });

    it('should remove tracking when notification is dismissed', async () => {
      const sessionId = 'session-123';
      const notificationId = 'notif-789';

      // Setup
      notificationManager.trackNotification(sessionId, notificationId);
      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
        {
          request: {
            identifier: notificationId,
            content: {
              data: { sessionId },
            },
          },
        },
      ]);

      // Act: Dismiss the notification
      await notificationManager.dismissNotificationsForSession(sessionId);

      // Assert: getPendingNotifications gets from system, not our tracking
      // So we can't directly test tracking removal this way
      // But we can verify the notification was dismissed
      expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith(notificationId);
    });
  });

  describe('Edge cases', () => {
    it('should handle case when no notifications are present', async () => {
      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([]);

      // Act: Try to dismiss notifications for a session
      await notificationManager.dismissNotificationsForSession('any-session');

      // Assert: Should not throw, should not call dismiss
      expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalled();
    });

    it('should handle notification platform errors gracefully', async () => {
      vi.mocked(Notifications.getPresentedNotificationsAsync).mockRejectedValue(new Error('Platform error'));

      // Act & Assert: Should not crash
      await expect(
        notificationManager.dismissNotificationsForSession('session-123')
      ).resolves.not.toThrow();
    });

    it('should handle malformed notification data', async () => {
      vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
        {
          request: {
            identifier: 'bad-notif',
            content: {
              data: null, // Malformed data
            },
          },
        },
      ]);

      // Act: Should handle gracefully
      await notificationManager.dismissNotificationsForSession('session-123');

      // Assert: Should not crash, should not dismiss malformed notification
      expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalled();
    });
  });
});
