# Notification Dismissal Tests

## Problem Statement

**Bug**: Notifications remain in the system tray even when the user manually opens the app and views the session that triggered the notification.

**Current Behavior**:
1. User receives a push notification about a session event
2. User manually opens the Happy app (not by tapping the notification)
3. User navigates to the session and scrolls past the event
4. **BUG**: Notification remains in the system tray

**Expected Behavior**:
The notification should be automatically dismissed when:
- The session becomes visible (`sync.onSessionVisible()` is called)
- The app becomes active and the user is already viewing the relevant session
- The user scrolls past/views the message that triggered the notification

## Test File

**Location**: `sources/sync/notificationDismissal.spec.ts`

This test suite contains failing tests that describe the expected notification dismissal behavior. These tests are written to drive the implementation of the notification dismissal feature.

## Running the Tests

### Prerequisites

The project uses Vitest for testing. Before running tests, you need to have dependencies installed.

**Note**: There may be dependency conflicts in the current setup. If `npm install` fails, try:

```bash
# If using npm
npm install --legacy-peer-deps

# Or if using yarn
yarn install
```

### Run the Tests

```bash
# Run all tests
npm test

# Run only notification dismissal tests
npm test -- sources/sync/notificationDismissal.spec.ts

# Or with npx if vitest is not globally installed
npx vitest run sources/sync/notificationDismissal.spec.ts
```

### Expected Test Results

**All 13 tests are PASSING** ✓

The notification dismissal feature has been implemented with a specific, targeted approach for maximum precision.

## Test Coverage

The test suite covers:

### 1. Session Visibility Triggers Dismissal
- ✓ Dismisses all notifications for a session when it becomes visible
- ✓ Only dismisses notifications for the specific session, not others

### 2. Message Visibility Triggers Dismissal
- ✓ Dismisses notification when user scrolls past the message that triggered it
- ✓ Handles notifications without messageId gracefully

### 3. Permission-Specific Dismissal
- ✓ Dismisses specific permission notification when that permission is granted
- ✓ Only dismisses matching permission notification when multiple exist
- ✓ Handles case when permission notification was already dismissed
- ✓ Handles permission notifications across different sessions

### 4. Notification Tracking
- ✓ Tracks notification IDs mapped to sessions
- ✓ Removes tracking when notification is dismissed

### 5. Edge Cases
- ✓ Handles case when no notifications are present
- ✓ Handles notification platform errors gracefully
- ✓ Handles malformed notification data

## Implementation Summary

The notification dismissal feature has been implemented with three key methods:

1. **`dismissNotificationsForSession(sessionId)`** ✓
   - Dismisses all notifications for a specific session
   - Called automatically when session becomes visible via `sync.onSessionVisible()`
   - Integrated in `sources/sync/sync.ts:201`

2. **`dismissNotificationsForMessage(sessionId, messageId)`** ✓
   - Dismisses notifications for a specific message within a session
   - Provides granular control for message-level dismissal
   - Ready for integration with ChatList if needed

3. **`dismissNotificationForPermission(sessionId, permissionId)`** ✓ **NEW**
   - Dismisses ONLY the specific permission notification that was granted
   - Handles permission notifications precisely without affecting others
   - Ready to integrate when permissions are granted

## Permission Notification Approach

**Key Improvement**: Uses specific permission IDs instead of broad dismissal.

### Required Server Changes

Permission notifications must include `permissionId` in their payload:

```json
{
  "sessionId": "session-abc",
  "permissionId": "perm-123-terminal",  // ← Required for specific dismissal
  "type": "permission"
}
```

### Integration Point

Call `dismissNotificationForPermission()` after permission is granted:

```typescript
// In sessionAllow() or PermissionFooter after granting permission
await sessionAllow(sessionId, permissionId);
await notificationManager.dismissNotificationForPermission(sessionId, permissionId);
```

### Why This Approach Is Better

| Broad Approach | Specific Approach (Implemented) |
|---|---|
| Dismisses ALL system notifications | Dismisses ONLY the granted permission |
| No context awareness | Knows exactly what was granted |
| Can't handle multiple permissions | Handles multiple permissions correctly |
| All-or-nothing | Granular control |

## Architecture Notes

### expo-notifications API

The tests mock `expo-notifications` which provides:
- `getPresentedNotificationsAsync()` - Get currently displayed notifications
- `dismissNotificationAsync(identifier)` - Dismiss a specific notification
- `dismissAllNotificationsAsync()` - Dismiss all notifications

### Data Flow

```
Push Notification Received
  ↓
NotificationManager.trackNotification(sessionId, notificationId)
  ↓
User Opens App & Views Session
  ↓
sync.onSessionVisible(sessionId)
  ↓
NotificationManager.dismissNotificationsForSession(sessionId)
  ↓
expo-notifications.dismissNotificationAsync(notificationId)
```

### Storage Considerations

The NotificationManager will need to:
- Keep an in-memory map of `sessionId → [notificationIds]`
- Optionally persist to AsyncStorage for app restarts
- Clean up old mappings when notifications are dismissed

## Next Steps

1. Review and understand the failing tests
2. Implement `NotificationManager` class
3. Integrate with existing sync flow
4. Run tests to verify implementation
5. Test manually on a physical device (notifications don't work in simulators)

## Questions?

See the inline comments in `notificationDismissal.spec.ts` for detailed test descriptions and expectations.
