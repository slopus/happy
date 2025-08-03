import { tracking } from './tracking';

// Re-export tracking for direct access
export { tracking } from './tracking';

/**
 * Initialize tracking with an anonymous user ID.
 * Should be called once during auth initialization.
 */
export function initializeTracking(anonymousUserId: string) {
    tracking?.identify(anonymousUserId, { name: anonymousUserId });
}

/**
 * Auth events
 */
export function trackAccountCreated() {
    tracking?.capture('account_created');
}

export function trackAccountRestored() {
    tracking?.capture('account_restored');
}

export function trackLogout() {
    tracking?.reset();
}

/**
 * Core user interactions
 */
export function trackConnectAttempt() {
    tracking?.capture('connect_attempt');
}

export function trackMessageSent() {
    tracking?.capture('message_sent');
}

export function trackVoiceRecording(action: 'start' | 'stop') {
    tracking?.capture('voice_recording', { action });
}

export function trackPermissionResponse(allowed: boolean) {
    tracking?.capture('permission_response', { allowed });
}

