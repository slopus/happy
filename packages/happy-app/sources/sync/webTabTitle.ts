/**
 * Web-only: prefix the browser tab title with "(N) " when new messages arrive
 * while the tab is hidden or unfocused — same pattern as Telegram/Discord/etc.
 * Resets the counter when the tab regains visibility + focus.
 *
 * The base title (e.g. screen-specific titles set by Expo Router) is recovered
 * by stripping our own "(N) " prefix on every apply, so we don't fight other
 * code that updates document.title.
 */

import { Platform } from 'react-native';

let unreadCount = 0;
let initialized = false;

function isVisible(): boolean {
    if (typeof document === 'undefined') {
        return true;
    }
    const visible = document.visibilityState === 'visible';
    const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    return visible && focused;
}

function applyTitle() {
    if (typeof document === 'undefined') {
        return;
    }
    const stripped = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = unreadCount > 0 ? `(${unreadCount}) ${stripped}` : stripped;
}

function ensureInit() {
    if (initialized || Platform.OS !== 'web' || typeof document === 'undefined') {
        return;
    }
    initialized = true;
    const reset = () => {
        if (isVisible() && unreadCount !== 0) {
            unreadCount = 0;
            applyTitle();
        }
    };
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('focus', reset);
}

export function notifyUnreadMessage() {
    if (Platform.OS !== 'web') {
        return;
    }
    ensureInit();
    if (isVisible()) {
        return;
    }
    unreadCount++;
    applyTitle();
}
