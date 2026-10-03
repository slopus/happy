import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { tracking } from './tracking';
import type { Metadata } from '@/sync/storageTypes';

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

/**
 * Counts a switch. Deliberately carries no properties.
 *
 * This event used to send the relay's own Session id and three exact
 * server-side timestamps. The distinct id PostHog sees is derived from the
 * account secret and is unlinkable on its own, but those properties join
 * straight back to the Session table, so the pair re-identified the profile.
 * If per-session analysis is wanted later, it needs an identifier the relay
 * cannot compute — a client-generated value stored only on the device.
 */
export function trackSessionSwitched() {
    tracking?.capture('session_switched');
}

export type MessageSentSource = 'chat' | 'new_session' | 'option' | 'question' | 'voice';

export function trackMessageSent(source: MessageSentSource, metadata?: Metadata | null) {
    tracking?.capture('message_sent', {
        source,
        session_agent: metadata?.flavor === 'gpt' || metadata?.flavor === 'openai'
            ? 'codex'
            : metadata?.flavor ?? null,
        session_started_source: metadata?.startedBy === 'daemon' || metadata?.startedFromDaemon === true
            ? 'daemon'
            : metadata?.startedBy === 'terminal' || metadata?.startedFromDaemon === false
                ? 'cli'
                : null,
        happy_cli_version: metadata?.version ?? null,
        ota_version: Updates.updateId ?? null,
        ota_runtime_version: Updates.runtimeVersion
            ?? (typeof Constants.expoConfig?.runtimeVersion === 'string' ? Constants.expoConfig.runtimeVersion : null),
    });
}

type OtaEventProperties = {
    ota_version?: string;
    ota_runtime_version?: string;
};

export function trackVoicePermissionResponse(allowed: boolean) {
    tracking?.capture('voice_permission_response', { allowed });
}

/**
 * Paywall events
 */
export function trackPaywallButtonClicked(flow?: string) {
    tracking?.capture('paywall_button_clicked', flow ? { flow } : undefined);
}

export function trackPaywallPresented(flow?: string) {
    tracking?.capture('paywall_presented', flow ? { flow } : undefined);
}

export function trackPaywallPurchased(flow?: string) {
    tracking?.capture('paywall_purchased', flow ? { flow } : undefined);
}

export function trackPaywallCancelled(flow?: string) {
    tracking?.capture('paywall_cancelled', flow ? { flow } : undefined);
}

export function trackPaywallRestored(flow?: string) {
    tracking?.capture('paywall_restored', flow ? { flow } : undefined);
}

export function trackPaywallError(error: string, flow?: string) {
    const properties: Record<string, string> = { error };
    if (flow) {
        properties.flow = flow;
    }
    tracking?.capture('paywall_error', properties);
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
export function trackOtaUpdateAvailable(properties?: OtaEventProperties) {
    tracking?.capture('ota_update_available', {
        ota_version: properties?.ota_version ?? null,
        ota_runtime_version: properties?.ota_runtime_version ?? null,
    });
}

export function trackOtaUpdateApplied(properties?: OtaEventProperties) {
    tracking?.capture('ota_update_applied', {
        ota_version: properties?.ota_version ?? null,
        ota_runtime_version: properties?.ota_runtime_version ?? null,
    });
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
