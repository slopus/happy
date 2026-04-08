import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { tracking } from './tracking';
import type { Metadata, Session } from '@/sync/storageTypes';

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

export function trackSessionSwitched(session: Pick<Session, 'id' | 'createdAt' | 'activeAt' | 'updatedAt'>) {
    tracking?.capture('session_switched', {
        session_id: session.id,
        session_created_at: session.createdAt,
        last_active_at: session.activeAt,
        last_updated_at: session.updatedAt,
    });
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
