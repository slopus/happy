import type { AlertButton } from './types';

/**
 * Android's native dialog has three button slots (neutral, negative,
 * positive). React Native keeps the first three buttons and silently drops
 * the rest, so callers with more choices trim them on Android.
 */
export const ANDROID_NATIVE_ALERT_MAX_BUTTONS = 3;

/**
 * Whether tapping outside or pressing Back may close the alert, and what that
 * counts as. Only an alert that already offers a way out can be dismissed:
 * one with a Cancel button (dismissing presses it) or one with no actions at
 * all. An alert whose only button does something keeps waiting for that tap.
 */
export function getAlertDismissal(buttons: AlertButton[] | undefined): { dismissible: boolean; onDismiss?: () => void } {
    if (!buttons || buttons.length === 0) {
        return { dismissible: true };
    }
    const cancel = buttons.find((button) => button.style === 'cancel');
    if (cancel) {
        return { dismissible: true, onDismiss: cancel.onPress };
    }
    if (buttons.every((button) => !button.onPress)) {
        return { dismissible: true };
    }
    return { dismissible: false };
}
