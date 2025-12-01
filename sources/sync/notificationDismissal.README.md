# Permission Notification Dismissal

## Problem Statement

**Bug**: Permission notifications remain in the system tray even when the user manually opens the app and grants the permission.

**Current Behavior**:
1. User receives a push notification about a permission request
2. User manually opens the Happy app (not by tapping the notification)
3. User grants the requested permission
4. **BUG**: Notification remains in the system tray

**Expected Behavior**:
The permission notification should be automatically dismissed when the user grants that specific permission.

## Test File

**Location**: `sources/sync/notificationDismissal.spec.ts`

This test suite contains tests that describe the expected permission notification dismissal behavior.

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

**All 4 tests are PASSING** ✓

The permission notification dismissal feature has been implemented with a specific, targeted approach.

## Test Coverage

The test suite covers:

### Permission-Specific Dismissal
- ✓ Dismisses specific permission notification when that permission is granted
- ✓ Only dismisses matching permission notification when multiple exist
- ✓ Handles case when permission notification was already dismissed
- ✓ Handles permission notifications across different sessions

## Implementation Summary

The notification dismissal feature provides one method:

**`dismissNotificationForPermission(sessionId, permissionId)`**
- Dismisses ONLY the specific permission notification that was granted
- Matches notifications by BOTH `sessionId` AND `permissionId`
- Handles multiple permission notifications correctly
- Ready to integrate when permissions are granted

## Permission Notification Approach

**Key Design**: Uses specific permission IDs for precise dismissal.

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

### Why This Approach

| Feature | Benefit |
|---|---|
| Permission-specific matching | Dismisses ONLY the granted permission |
| Requires both sessionId and permissionId | Prevents accidental dismissal |
| Context-aware | Knows exactly what was granted |
| Multi-permission support | Handles multiple permissions correctly |
| Granular control | Precise notification management |

## Architecture Notes

### expo-notifications API

The implementation uses `expo-notifications` which provides:
- `getPresentedNotificationsAsync()` - Get currently displayed notifications
- `dismissNotificationAsync(identifier)` - Dismiss a specific notification

### Data Flow

```
Permission Notification Received (with permissionId in data)
  ↓
User Opens App
  ↓
User Grants Permission
  ↓
sessionAllow(sessionId, permissionId)
  ↓
notificationManager.dismissNotificationForPermission(sessionId, permissionId)
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

1. Integrate `dismissNotificationForPermission()` in permission grant flow
2. Ensure server includes `permissionId` in permission notification payloads
3. Test manually on a physical device (notifications don't work in simulators)

## Questions?

See the inline comments in `notificationDismissal.spec.ts` for detailed test descriptions and expectations.
