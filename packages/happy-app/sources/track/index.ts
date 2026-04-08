import { tracking } from './tracking';
import type { Session } from '@/sync/storageTypes';

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

export function trackSessionSwitched(session: Pick<Session, 'activeAt' | 'updatedAt'>) {
    tracking?.capture('session_switched', {
        last_active_at: session.activeAt,
        last_updated_at: session.updatedAt,
    });
}

export function trackMessageSent() {
    tracking?.capture('message_sent');
}

export function trackVoiceMessageSent() {
    tracking?.capture('voice_message_sent');
}

export function trackVoicePermissionResponse(allowed: boolean) {
    tracking?.capture('voice_permission_response', { allowed });
}

/**
 * Paywall events
 */
export function trackPaywallButtonClicked(flow?: string) {
    tracking?.capture('paywall_button_clicked', { flow });
}

export function trackPaywallPresented(flow?: string) {
    tracking?.capture('paywall_presented', { flow });
}

export function trackPaywallPurchased(flow?: string) {
    tracking?.capture('paywall_purchased', { flow });
}

export function trackPaywallCancelled(flow?: string) {
    tracking?.capture('paywall_cancelled', { flow });
}

export function trackPaywallRestored(flow?: string) {
    tracking?.capture('paywall_restored', { flow });
}

export function trackPaywallError(error: string, flow?: string) {
    tracking?.capture('paywall_error', {
        error,
        flow,
    });
}

/**
 * Review request events
 */
export function trackReviewPromptShown() {
    tracking?.capture('review_prompt_shown');
}

export function trackReviewPromptResponse(likesApp: boolean) {
    tracking?.capture('review_prompt_response', { likes_app: likesApp });
}

export function trackReviewStoreShown() {
    tracking?.capture('review_store_shown');
}

export function trackReviewRetryScheduled(daysUntilRetry: number) {
    tracking?.capture('review_retry_scheduled', { days_until_retry: daysUntilRetry });
}

/**
 * OTA update events
 */
export function trackOtaUpdateAvailable() {
    tracking?.capture('ota_update_available');
}

export function trackOtaUpdateApplied() {
    tracking?.capture('ota_update_applied');
}

/**
 * What's New / Changelog events
 */
export function trackWhatsNewClicked() {
    tracking?.capture('whats_new_clicked');
}

/**
 * Friends feature events
 *
 * NOTE: We're measuring how interested people are in the friend feature as-is,
 * considering removing the tab to avoid confusion.
 */
export function trackFriendsSearch() {
    tracking?.capture('friends_search');
}

export function trackFriendsProfileView() {
    tracking?.capture('friends_profile_view');
}

export function trackFriendsConnect() {
    tracking?.capture('friends_connect');
}

export function trackGitHubConnected() {
    tracking?.capture('github_connected');
}
