# Session Actions — Inline Expand Design

## Summary

Add a three-dot menu button to each session row in the sidebar. Tapping it expands the row to reveal action buttons. Remove Swipeable gesture — same UX on all platforms.

## UI Behavior

### Normal state
- Three-dot button (ellipsis-horizontal) on the right side of each session row, vertically centered
- Subtle, uses `textSecondary` color

### Expanded state (after tapping dots)
- Row expands downward with LayoutAnimation
- Three action buttons appear in a horizontal row below session info
- Only one session can be expanded at a time

### Closing
- Tap dots again
- Tap the session row (navigates to session)
- Expand a different session

## Action Buttons

| Button | Icon | Action | Long Press |
|--------|------|--------|------------|
| Restart | `refresh-outline` | kill + deactivate + resume (same claudeSessionId + path) | — |
| Archive | `archive-outline` | kill + deactivate | kill + delete |
| Delete | `trash-outline` | Modal.alert confirm, then kill + delete | — |

### Operations mapping
- **Restart**: `sessionKill(id)` -> `sessionDeactivate(id)` -> `sessionResume(claudeSessionId, path)`
- **Archive**: `sessionKill(id)` -> `sessionDeactivate(id)`
- **Archive (long press)**: `sessionKill(id)` -> `sessionDelete(id)`
- **Delete**: confirm via Modal.alert -> `sessionKill(id)` -> `sessionDelete(id)`

## Styling

- Action panel background: `theme.colors.surfaceHighest`
- Button style: icon + label, equal width (flex: 1), compact padding
- Delete button: `theme.colors.status.error` for icon and text
- Restart/Archive: `theme.colors.text` for icon and text

## State Management

- `expandedSessionId: string | null` state in `ActiveSessionsGroup`
- Passed down to `CompactSessionRow` as `expanded` prop + `onToggleExpand` callback

## Files to Change

1. `ActiveSessionsGroup.tsx` — remove Swipeable, add dots button, expand panel, action handlers
2. Translations — add keys for restart, archive, delete labels and confirmations

## Platform Behavior

- Identical on iOS, Android, and Web
- Swipeable removed entirely
