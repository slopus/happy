import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Test suite for notification dismissal behavior
 *
 * Bug: Permission notifications remain in the system tray even when the user:
 * 1. Manually opens the app (not via notification tap)
 * 2. Grants the permission that triggered the notification
 *
 * Expected behavior: Permission notifications should be automatically dismissed when:
 * - The user grants the specific permission that triggered the notification
 */

// Mock expo-notifications - mocks must be hoisted, so we can't use const outside
vi.mock('expo-notifications', () => ({
  default: {
    dismissNotificationAsync: vi.fn(),
    getPresentedNotificationsAsync: vi.fn(),
  },
  dismissNotificationAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(),
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

describe('Permission Notification Dismissal', () => {
  let notificationManager: NotificationManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([]);
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined);

    // Create a fresh NotificationManager instance for each test
    notificationManager = new NotificationManager();
  });

  it('should dismiss specific permission notification when that permission is granted', async () => {
    // Setup: Simulate a permission notification in the tray
    // Permission notifications have a permissionId that matches the permission.id
    const sessionId = 'session-abc';
    const permissionId = 'perm-123-terminal-access';
    const notificationId = 'notif-permission-request';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: notificationId,
          content: {
            title: 'Permission Request',
            body: 'Machine "my-machine" is requesting terminal access',
            data: {
              sessionId,
              permissionId, // The specific permission ID
              type: 'permission',
            },
          },
        },
      },
    ]);

    // Act: User grants this specific permission
    // This should dismiss ONLY the notification for this permissionId
    await notificationManager.dismissNotificationForPermission(sessionId, permissionId);

    // Assert: Permission notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith(notificationId);
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });

  it('should only dismiss matching permission notification when multiple exist', async () => {
    // Setup: Multiple permission notifications for different permissions
    const sessionId = 'session-abc';
    const permissionId1 = 'perm-123-terminal';
    const permissionId2 = 'perm-456-file-access';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: 'notif-perm-1',
          content: {
            data: {
              sessionId,
              permissionId: permissionId1,
              type: 'permission',
            },
          },
        },
      },
      {
        request: {
          identifier: 'notif-perm-2',
          content: {
            data: {
              sessionId,
              permissionId: permissionId2,
              type: 'permission',
            },
          },
        },
      },
    ]);

    // Act: Grant only the first permission
    await notificationManager.dismissNotificationForPermission(sessionId, permissionId1);

    // Assert: Only the first permission's notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith('notif-perm-1');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalledWith('notif-perm-2');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });

  it('should handle case when permission notification was already dismissed', async () => {
    // Setup: No notifications present
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([]);

    // Act: Try to dismiss a permission notification that doesn't exist
    await notificationManager.dismissNotificationForPermission('session-abc', 'perm-123');

    // Assert: Should not throw, should not attempt to dismiss anything
    expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalled();
  });

  it('should handle permission notifications across different sessions', async () => {
    // Setup: Permission notifications for different sessions
    const session1 = 'session-abc';
    const session2 = 'session-xyz';
    const permissionId = 'perm-123-terminal';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: 'notif-session1-perm',
          content: {
            data: {
              sessionId: session1,
              permissionId,
              type: 'permission',
            },
          },
        },
      },
      {
        request: {
          identifier: 'notif-session2-perm',
          content: {
            data: {
              sessionId: session2,
              permissionId,
              type: 'permission',
            },
          },
        },
      },
    ]);

    // Act: Grant permission in session1 only
    await notificationManager.dismissNotificationForPermission(session1, permissionId);

    // Assert: Only session1's notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith('notif-session1-perm');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalledWith('notif-session2-perm');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });
});
