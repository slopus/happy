# Notification Dismissal

## Problem Statement

**Bug**: Notifications remain in the system tray even when the user manually opens the app and handles the event that triggered them.

**Current Behavior**:
1. User receives a push notification (permission request, friend request, etc.)
2. User manually opens the Happy app (not by tapping the notification)
3. User handles the event (grants permission, accepts friend request, etc.)
4. **BUG**: Notification remains in the system tray

**Expected Behavior**:
Notifications should be automatically dismissed when the user handles the specific event that triggered them.

## Test File

**Location**: `sources/sync/notificationDismissal.spec.ts`

This test suite contains tests that describe the expected notification dismissal behavior.

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

**All 10 tests are PASSING** ✓

The notification dismissal feature has been implemented with specific, targeted approaches for each notification type.

## Test Coverage

The test suite covers:

### Permission-Specific Dismissal (4 tests)
- ✓ Dismisses specific permission notification when that permission is granted
- ✓ Only dismisses matching permission notification when multiple exist
- ✓ Handles case when permission notification was already dismissed
- ✓ Handles permission notifications across different sessions

### Friend Request Dismissal (6 tests)
- ✓ Dismisses incoming friend request notification when accepted
- ✓ Dismisses outgoing friend request notification when other user responds
- ✓ Only dismisses matching friend request when multiple exist
- ✓ Distinguishes between incoming and outgoing friend request notifications
- ✓ Handles case when friend request notification was already dismissed
- ✓ Does not dismiss other notification types when dismissing friend requests

## Implementation Summary

The notification dismissal feature provides two methods:

### 1. Permission Notifications

**`dismissNotificationForPermission(sessionId, permissionId)`**
- Dismisses ONLY the specific permission notification
- Matches notifications by BOTH `sessionId` AND `permissionId`
- Called when user grants or denies a permission

**Required notification payload:**
```json
{
  "sessionId": "session-abc",
  "permissionId": "perm-123-terminal",
  "type": "permission"
}
```

**Integration point:**
```typescript
// In sessionAllow() or PermissionFooter after granting permission
await sessionAllow(sessionId, permissionId);
await notificationManager.dismissNotificationForPermission(sessionId, permissionId);
```

### 2. Friend Request Notifications

**`dismissNotificationForFriendRequest(userId, requestType)`**
- Dismisses ONLY the specific friend request notification
- Matches by `userId`, `type='friend_request'`, and `requestType`
- `requestType`: `'incoming'` for received requests, `'outgoing'` for sent requests
- Called when user accepts/rejects a friend request or when the other user responds

**Required notification payload:**
```json
{
  "userId": "user-123",
  "type": "friend_request",
  "requestType": "incoming"  // or "outgoing"
}
```

**Integration points:**
```typescript
// When accepting/rejecting incoming friend request
await acceptFriendRequest(userId);
await notificationManager.dismissNotificationForFriendRequest(userId, 'incoming');

// When other user responds to your outgoing request
await notificationManager.dismissNotificationForFriendRequest(userId, 'outgoing');
```

## Design Principles

| Feature | Benefit |
|---|---|
| Event-specific matching | Dismisses ONLY the handled event |
| Multiple identifiers | Prevents accidental dismissal |
| Context-aware | Knows exactly what was handled |
| Multi-event support | Handles multiple notifications correctly |
| Granular control | Precise notification management |

## Architecture Notes

### expo-notifications API

The implementation uses `expo-notifications` which provides:
- `getPresentedNotificationsAsync()` - Get currently displayed notifications
- `dismissNotificationAsync(identifier)` - Dismiss a specific notification

### Data Flow

```
Notification Received (with specific IDs in data)
  ↓
User Opens App
  ↓
User Handles Event (grant permission, accept friend, etc.)
  ↓
notificationManager.dismissNotificationFor...(...)
  ↓
expo-notifications.dismissNotificationAsync(notificationId)
```

### Storage Considerations

The NotificationManager:
- Does NOT maintain in-memory state
- Queries the system directly via `getPresentedNotificationsAsync()`
- No persistence needed - relies on notification payload data
- No cleanup required - notifications are managed by the OS

## Next Steps

1. Integrate dismissal calls in appropriate event handlers
2. Ensure server includes required IDs in notification payloads
3. Test manually on a physical device (notifications don't work in simulators)

## Questions?

See the inline comments in `notificationDismissal.spec.ts` for detailed test descriptions and expectations.
