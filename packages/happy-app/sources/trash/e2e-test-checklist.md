# Tauri Desktop E2E Test Checklist

## Prerequisites
- `pnpm tauri:dev` running
- User logged in (create account or QR scan)

## Test Cases

### TC-01: Window Launch
- [ ] App opens at ~1280x800 (not 800x600)
- [ ] Window has minimum size constraint (~900px wide)
- [ ] Title bar shows "Happy (dev)"

### TC-02: Three-Column Layout (logged in)
- [ ] Left: SidebarView with header ("Happy", connection status, icons)
- [ ] Center: Current route content (e.g., "No active sessions" or Settings)
- [ ] Right: ContextPanel showing "Context panel / Coming soon"
- [ ] Columns have visible dividers between them

### TC-03: Navigation Persistence
- [ ] Click Settings icon → Center column shows Settings, sidebar stays
- [ ] Click "+" (new session) → Center shows "Start New Session", sidebar stays
- [ ] Navigate back → Previous view restores, sidebar unchanged throughout

### TC-04: Zen Mode
- [ ] Press Cmd+0 → Both side panels disappear, center fills window
- [ ] Press Cmd+0 again → Side panels restore
- [ ] Zen state persists after page navigation

### TC-05: System Tray
- [ ] Happy icon visible in macOS menu bar
- [ ] Click tray icon → Menu appears with: Show Window, sessions, New Session, Quit
- [ ] Click "Quit" → App exits

### TC-06: Close Confirmation
- [ ] Click red close button (traffic lights)
- [ ] Native dialog: "Are you sure you want to quit?" with Yes/No
- [ ] Click "No" → Window stays open
- [ ] Click "Yes" → App exits

### TC-07: Dark Mode
- [ ] Switch to dark mode in Settings → Appearance
- [ ] All three columns render correctly in dark mode
- [ ] No white flashes or broken colors

### TC-08: Content Width
- [ ] Content in center column has reasonable max-width (not stretching edge-to-edge)
- [ ] Images/logos don't overflow or become oversized
- [ ] Text remains readable width

### TC-09: No Console Errors
- [ ] Open DevTools (Cmd+Option+I if available)
- [ ] No red errors related to our changes (isTauri, notifications, layout)
- [ ] "12000ms timeout" is pre-existing, acceptable

### TC-10: Mobile/Web Regression
- [ ] Open `http://localhost:8081` in regular browser
- [ ] Shows normal web layout (no three-column, no ContextPanel)
- [ ] No Tauri-related errors in browser console
