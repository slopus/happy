/**
 * iOS draws a menu's items bottom-up when the menu opens upward, so the row
 * nearest the trigger is the one listed first. Every menu Happy opens from the
 * composer is anchored at the bottom of the screen and therefore always opens
 * upward, which printed our carefully ranked lists backwards: the harness
 * picker read Antigravity, Codex, Claude Code, and the permission picker put
 * Default on top and Auto at the very bottom.
 *
 * SwiftUI fixes this with `.menuOrder(.fixed)`, but @expo/ui does not expose
 * that modifier, so the order is reversed here instead and iOS reverses it
 * back. Android and web draw items top-down and are left alone.
 *
 * This is presentation only. It never touches the order the pickers hand us,
 * which stays the shared ranking in permissionModeLabels.ts.
 */
export function orderNativeMenuItems<T>(items: readonly T[], platform: string): T[] {
    return platform === 'ios' ? [...items].reverse() : [...items];
}
