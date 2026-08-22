import { VoiceSessionCancellationError, type VoiceSession } from './types';
import { fetchVoiceCredentials } from '@/sync/apiVoice';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import {
    getVoiceMessageCount,
    getVoiceOnboardingPromptLoadCount,
    getVoiceSoftPaywallShownCount,
    incrementVoiceOnboardingPromptLoadCount,
    incrementVoiceSoftPaywallShown,
} from '@/sync/persistence';
import { buildVoiceFirstMessage, buildVoiceSystemPrompt } from './voiceSystemPrompt';
import { getVoiceUpsellVariant } from './voiceExperiment';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;
let currentVoiceConversationId: string | null = null;
let currentVoiceSessionStartedAt: number | null = null;
let startInFlight: Promise<string | null> | null = null;
let stopInFlight: Promise<void> | null = null;
let startAttemptGeneration = 0;
const PROVIDER_RESET_TIMEOUT_MS = 5_000;
type ProviderResetWaiter = {
    previous: VoiceSession | null;
    resolve: () => void;
    timeout: ReturnType<typeof setTimeout>;
};
const providerResetWaiters = new Set<ProviderResetWaiter>();

function assertStartAttemptActive(generation: number) {
    if (generation !== startAttemptGeneration) {
        throw new VoiceSessionCancellationError();
    }
}

/**
 * Start a voice session. Returns the ElevenLabs conversation ID if started, null otherwise.
 */
export function startRealtimeSession(sessionId: string, initialContext?: string): Promise<string | null> {
    if (startInFlight) return startInFlight;
    if (stopInFlight) {
        return stopInFlight.then(() => startRealtimeSession(sessionId, initialContext));
    }

    const generation = ++startAttemptGeneration;
    const attempt = startRealtimeSessionInternal(sessionId, initialContext, generation);
    startInFlight = attempt.finally(() => {
        startInFlight = null;
    });
    return startInFlight;
}

async function startRealtimeSessionInternal(
    sessionId: string,
    initialContext: string | undefined,
    generation: number,
): Promise<string | null> {
    currentVoiceConversationId = null;
    currentVoiceSessionStartedAt = null;

    if (!voiceSession) {
        console.warn('No voice session registered');
        return null;
    }

    // Show connecting state immediately so the user sees feedback
    storage.getState().setRealtimeStatus('connecting');

    try {
        // Request microphone permission before starting voice session.
        // Keep it in the guarded attempt so Stop can cancel the permission flow.
        const permissionResult = await requestMicrophonePermission();
        assertStartAttemptActive(generation);
        if (!permissionResult.granted) {
            storage.getState().setRealtimeStatus('disconnected');
            showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
            return null;
        }

        // Bypass Happy server token — only when user has their own custom agent
        const { voiceBypassToken, voiceCustomAgentId } = storage.getState().settings;
        if (voiceBypassToken && voiceCustomAgentId) {
            console.log('[Voice] Bypassing token, custom agent ID:', voiceCustomAgentId);
            currentSessionId = sessionId;
            const conversationId = await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId: voiceCustomAgentId,
            });
            assertStartAttemptActive(generation);
            currentVoiceConversationId = conversationId;
            currentVoiceSessionStartedAt = Date.now();
            voiceSessionStarted = true;
            return conversationId;
        }

        const credentials = await TokenStorage.getCredentials();
        assertStartAttemptActive(generation);
        if (!credentials) {
            storage.getState().setRealtimeStatus('disconnected');
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return null;
        }

        const response = await fetchVoiceCredentials(credentials, sessionId);
        assertStartAttemptActive(generation);
        console.log('[Voice] Credentials response:', response.allowed
            ? {
                allowed: true,
                conversationId: response.conversationId,
                usedSeconds: response.usedSeconds,
                limitSeconds: response.limitSeconds,
            }
            : {
                allowed: false,
                reason: response.reason,
                usedSeconds: response.usedSeconds,
                limitSeconds: response.limitSeconds,
            });

        if (!response.allowed) {
            storage.getState().setRealtimeStatus('disconnected');

            if (response.reason === 'voice_conversation_limit_reached') {
                Modal.alert(
                    t('errors.voiceLimitReachedTitle'),
                    t('errors.voiceConversationLimitReached'),
                );
                return null;
            }

            // Server hard-declined — must pay to continue
            console.log('[Voice] Not allowed (reason: %s), presenting must-pay paywall...', response.reason);
            const result = await sync.presentPaywall('voice_must_pay');
            assertStartAttemptActive(generation);
            console.log('[Voice] Must-pay paywall result:', result);
            if (result.purchased) {
                return startRealtimeSessionInternal(sessionId, initialContext, generation);
            }
            return null;
        }

        const hasPro = storage.getState().purchases.entitlements['pro'] ?? false;
        const { voiceUpsellOverride, devModeEnabled } = storage.getState().localSettings;
        const voiceUpsellVariant = getVoiceUpsellVariant({
            override: voiceUpsellOverride,
            overrideEnabled: __DEV__ || devModeEnabled,
        });

        if (
            !hasPro &&
            voiceUpsellVariant === 'show-paywall-before-first-voice-chat' &&
            getVoiceSoftPaywallShownCount() < 1
        ) {
            console.log('[Voice] First voice attempt on free tier, showing soft paywall...');
            incrementVoiceSoftPaywallShown();
            const result = await sync.presentPaywall('voice_trial_eligible');
            assertStartAttemptActive(generation);
            console.log('[Voice] Soft paywall result:', result);
            // Dismissed or error — continue anyway, they can still use free tier.
        }

        currentSessionId = sessionId;
        const onboardingPromptLoadCount = getVoiceOnboardingPromptLoadCount();
        const voiceMessageCount = getVoiceMessageCount();
        const systemPrompt = buildVoiceSystemPrompt({
            initialContext,
            onboardingPromptLoadCount,
            voiceMessageCount,
            includePaidVoiceOnboarding: !hasPro && voiceUpsellVariant === 'voice-onboarding-and-upsell',
        });
        const firstMessage = buildVoiceFirstMessage({
            hasPro,
            onboardingPromptLoadCount,
            includePaidVoiceOnboarding: voiceUpsellVariant === 'voice-onboarding-and-upsell',
        });

        const startedConversationId = await voiceSession.startSession({
            sessionId,
            initialContext,
            systemPrompt,
            firstMessage,
            conversationToken: response.conversationToken,
            agentId: response.agentId,
            userId: response.elevenUserId,
        });
        assertStartAttemptActive(generation);
        if (!hasPro && voiceUpsellVariant === 'voice-onboarding-and-upsell') {
            incrementVoiceOnboardingPromptLoadCount();
        }
        currentVoiceConversationId = response.conversationId ?? startedConversationId;
        currentVoiceSessionStartedAt = Date.now();
        voiceSessionStarted = true;
        return currentVoiceConversationId;
    } catch (error) {
        storage.getState().setRealtimeStatus('disconnected');
        currentSessionId = null;
        currentVoiceConversationId = null;
        currentVoiceSessionStartedAt = null;
        voiceSessionStarted = false;
        if (error instanceof VoiceSessionCancellationError) {
            return null;
        }
        console.error('Failed to start realtime session:', error);
        throw error;
    }
}

export function stopRealtimeSession(): Promise<void> {
    // Cancel permission/token/paywall work that has not reached the SDK yet.
    startAttemptGeneration++;
    if (stopInFlight) return stopInFlight;

    const attempt = stopRealtimeSessionInternal();
    stopInFlight = attempt.finally(() => {
        stopInFlight = null;
    });
    return stopInFlight;
}

async function stopRealtimeSessionInternal() {
    if (!voiceSession) {
        return;
    }

    try {
        await voiceSession.endSession();
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    } finally {
        currentSessionId = null;
        currentVoiceConversationId = null;
        currentVoiceSessionStartedAt = null;
        voiceSessionStarted = false;
    }
}

export function registerVoiceSession(session: VoiceSession) {
    if (voiceSession && voiceSession !== session) {
        console.warn('Voice session already registered, replacing with new one');
    }
    voiceSession = session;
    for (const waiter of providerResetWaiters) {
        if (session === waiter.previous) continue;
        providerResetWaiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve();
    }
}

export function unregisterVoiceSession(session: VoiceSession) {
    if (voiceSession === session) {
        voiceSession = null;
    }
}

export function resetVoiceProviderAndWait(): Promise<void> {
    const previous = voiceSession;
    return new Promise<void>((resolve) => {
        let waiter!: ProviderResetWaiter;
        waiter = {
            previous,
            resolve: () => {
                providerResetWaiters.delete(waiter);
                resolve();
            },
            timeout: setTimeout(() => waiter.resolve(), PROVIDER_RESET_TIMEOUT_MS),
        };
        providerResetWaiters.add(waiter);
        storage.getState().resetVoiceProvider();
    });
}

export function notifyVoiceSessionDisconnected() {
    currentSessionId = null;
    currentVoiceConversationId = null;
    currentVoiceSessionStartedAt = null;
    voiceSessionStarted = false;
}

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSession;
}

export function getCurrentRealtimeSessionId(): string | null {
    return currentSessionId;
}

export function getCurrentVoiceConversationId(): string | null {
    return currentVoiceConversationId;
}

export function getCurrentVoiceSessionDurationSeconds(): number | undefined {
    if (currentVoiceSessionStartedAt === null) {
        return undefined;
    }
    return Math.max(0, Math.round((Date.now() - currentVoiceSessionStartedAt) / 1000));
}

export function setCurrentRealtimeSessionId(sessionId: string) {
    currentSessionId = sessionId;
}
