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

**All tests should FAIL** because the notification dismissal feature is not yet implemented. The tests describe the behavior that needs to be built.

## Test Coverage

The test suite covers:

### 1. Session Visibility Triggers Dismissal
- ✗ Dismisses all notifications for a session when it becomes visible
- ✗ Only dismisses notifications for the specific session, not others

### 2. App State Change Triggers Dismissal
- ✗ Dismisses notifications when app becomes active and session is already open

### 3. Message Visibility Triggers Dismissal
- ✗ Dismisses notification when user scrolls past the message that triggered it
- ✗ Handles notifications without messageId gracefully

### 4. Notification Tracking
- ✗ Tracks notification IDs mapped to sessions
- ✗ Removes tracking when notification is dismissed

### 5. Edge Cases
- ✗ Handles case when no notifications are present
- ✗ Handles notification platform errors gracefully
- ✗ Handles malformed notification data

## Implementation Roadmap

To make these tests pass, you'll need to:

1. **Create NotificationManager** (`sources/sync/notificationManager.ts`):
   - Track notification IDs per session
   - Provide `dismissNotificationsForSession(sessionId)` method
   - Provide `dismissNotificationsForMessage(sessionId, messageId)` method
   - Handle edge cases (platform errors, malformed data)

2. **Integrate with Sync** (`sources/sync/sync.ts`):
   - Add notification dismissal to `onSessionVisible()` method (line ~188)
   - Add notification dismissal to AppState 'active' listener (line ~98-116)

3. **Update Push Notification Payload**:
   - Include `sessionId` in notification data
   - Optionally include `messageId` for granular dismissal

4. **Integrate with SessionView** (`sources/-session/SessionView.tsx`):
   - Ensure `sync.onSessionVisible()` is called when session mounts
   - This already happens, but verify it triggers notification dismissal

5. **Optional: Message-level Dismissal**:
   - Integrate with ChatList to dismiss notifications when specific messages scroll into view
   - This is more complex and may not be necessary if session-level dismissal is sufficient

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
