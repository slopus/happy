import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Test suite for notification dismissal behavior
 *
 * Bugs: Notifications remain in the system tray even when the user:
 * 1. Manually opens the app (not via notification tap)
 * 2. Handles the event that triggered the notification
 *
 * Expected behavior: Notifications should be automatically dismissed when:
 * - The user grants/denies a specific permission
 * - The user accepts/rejects a friend request
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

describe('Friend Request Notification Dismissal', () => {
  let notificationManager: NotificationManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([]);
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined);

    // Create a fresh NotificationManager instance for each test
    notificationManager = new NotificationManager();
  });

  it('should dismiss incoming friend request notification when accepted', async () => {
    // Setup: Simulate an incoming friend request notification
    const userId = 'user-123';
    const notificationId = 'notif-friend-request-incoming';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: notificationId,
          content: {
            title: 'Friend Request',
            body: 'Alice wants to be your friend',
            data: {
              userId,
              type: 'friend_request',
              requestType: 'incoming',
            },
          },
        },
      },
    ]);

    // Act: User accepts the friend request
    await notificationManager.dismissNotificationForFriendRequest(userId, 'incoming');

    // Assert: Friend request notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith(notificationId);
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });

  it('should dismiss outgoing friend request notification when other user responds', async () => {
    // Setup: Simulate an outgoing friend request notification (e.g., "Bob accepted your friend request")
    const userId = 'user-456';
    const notificationId = 'notif-friend-request-outgoing';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: notificationId,
          content: {
            title: 'Friend Request Accepted',
            body: 'Bob accepted your friend request',
            data: {
              userId,
              type: 'friend_request',
              requestType: 'outgoing',
            },
          },
        },
      },
    ]);

    // Act: User views the response or the app processes it
    await notificationManager.dismissNotificationForFriendRequest(userId, 'outgoing');

    // Assert: Friend request notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith(notificationId);
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });

  it('should only dismiss matching friend request when multiple exist', async () => {
    // Setup: Multiple friend request notifications
    const user1 = 'user-123';
    const user2 = 'user-456';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: 'notif-user1',
          content: {
            data: {
              userId: user1,
              type: 'friend_request',
              requestType: 'incoming',
            },
          },
        },
      },
      {
        request: {
          identifier: 'notif-user2',
          content: {
            data: {
              userId: user2,
              type: 'friend_request',
              requestType: 'incoming',
            },
          },
        },
      },
    ]);

    // Act: Accept only the first friend request
    await notificationManager.dismissNotificationForFriendRequest(user1, 'incoming');

    // Assert: Only the first user's notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith('notif-user1');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalledWith('notif-user2');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });

  it('should distinguish between incoming and outgoing friend request notifications', async () => {
    // Setup: Same user has both incoming and outgoing notifications
    const userId = 'user-789';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: 'notif-incoming',
          content: {
            data: {
              userId,
              type: 'friend_request',
              requestType: 'incoming',
            },
          },
        },
      },
      {
        request: {
          identifier: 'notif-outgoing',
          content: {
            data: {
              userId,
              type: 'friend_request',
              requestType: 'outgoing',
            },
          },
        },
      },
    ]);

    // Act: Dismiss only incoming notification
    await notificationManager.dismissNotificationForFriendRequest(userId, 'incoming');

    // Assert: Only the incoming notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith('notif-incoming');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalledWith('notif-outgoing');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });

  it('should handle case when friend request notification was already dismissed', async () => {
    // Setup: No notifications present
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([]);

    // Act: Try to dismiss a friend request notification that doesn't exist
    await notificationManager.dismissNotificationForFriendRequest('user-123', 'incoming');

    // Assert: Should not throw, should not attempt to dismiss anything
    expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalled();
  });

  it('should not dismiss other notification types when dismissing friend requests', async () => {
    // Setup: Mix of notification types
    const userId = 'user-123';

    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      {
        request: {
          identifier: 'notif-friend',
          content: {
            data: {
              userId,
              type: 'friend_request',
              requestType: 'incoming',
            },
          },
        },
      },
      {
        request: {
          identifier: 'notif-message',
          content: {
            data: {
              userId,
              type: 'message', // Different type
              sessionId: 'session-abc',
            },
          },
        },
      },
    ]);

    // Act: Dismiss friend request
    await notificationManager.dismissNotificationForFriendRequest(userId, 'incoming');

    // Assert: Only friend request notification should be dismissed
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledWith('notif-friend');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).not.toHaveBeenCalledWith('notif-message');
    expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(1);
  });
});
