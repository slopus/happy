import type { VoiceSession, VoiceSessionConfig } from './types';
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
import { tracking } from '@/track';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;
type VoiceSessionEndReason = 'manual_stop' | 'disconnected' | 'error' | 'unmount';
type ActiveVoiceSession = {
    voice: VoiceSession;
    sessionId: string;
    conversationId: string | null;
    connectedAt: number | null;
    end: { at: number; reason: VoiceSessionEndReason } | null;
    ready: boolean;
    startTracked: boolean;
};
let activeVoiceSession: ActiveVoiceSession | null = null;

function reportVoiceSession(session: ActiveVoiceSession) {
    // The SDK can disconnect before startSession resolves with the conversation ID.
    // Keep both timestamps, then emit the pair once that ID is available.
    if (!session.ready || session.connectedAt === null) return;
    const properties = {
        session_id: session.sessionId,
        elevenlabs_conversation_id: session.conversationId,
    };
    if (!session.startTracked) {
        session.startTracked = true;
        tracking?.capture('voice_session_started', {
            ...properties,
            has_pro: storage.getState().purchases.entitlements['pro'] ?? false,
            onboarding_prompt_load_count: getVoiceOnboardingPromptLoadCount(),
            voice_message_count: getVoiceMessageCount(),
        });
    }
    if (session.end) {
        const durationMs = Math.max(0, session.end.at - session.connectedAt);
        tracking?.capture('voice_session_ended', {
            ...properties,
            duration_ms: durationMs,
            duration_seconds: durationMs / 1000,
            end_reason: session.end.reason,
        });
    }
}

export function onRealtimeSessionConnected(voice: VoiceSession, conversationId?: string) {
    if (!activeVoiceSession || activeVoiceSession.voice !== voice || activeVoiceSession.end) return;
    activeVoiceSession.conversationId ||= conversationId || null;
    activeVoiceSession.connectedAt ??= performance.now();
    voiceSessionStarted = true;
    reportVoiceSession(activeVoiceSession);
}

export function finishRealtimeSession(reason: VoiceSessionEndReason, voice?: VoiceSession) {
    const session = activeVoiceSession;
    if (!session || (voice && session.voice !== voice)) return;
    // Clear first: manual stop, SDK disconnect and provider unmount can all fire.
    activeVoiceSession = null;
    currentSessionId = null;
    voiceSessionStarted = false;
    session.end = { at: performance.now(), reason };
    reportVoiceSession(session);
}

async function startVoiceSession(
    voice: VoiceSession,
    config: VoiceSessionConfig,
    options: { conversationId?: string; incrementOnboardingPromptLoad?: boolean } = {},
): Promise<string | null> {
    // Permission and credential requests can overlap before the SDK is started.
    if (activeVoiceSession) return activeVoiceSession.conversationId;
    const session: ActiveVoiceSession = {
        voice,
        sessionId: config.sessionId,
        conversationId: options.conversationId ?? null,
        connectedAt: null,
        end: null,
        ready: false,
        startTracked: false,
    };
    activeVoiceSession = session;
    currentSessionId = config.sessionId;
    try {
        const startedConversationId = await voice.startSession(config);
        session.conversationId ||= startedConversationId || null;
        if (options.incrementOnboardingPromptLoad) {
            incrementVoiceOnboardingPromptLoadCount();
        }
        session.ready = true;
        reportVoiceSession(session);
        return session.end ? null : session.conversationId;
    } catch (error) {
        session.ready = true;
        if (activeVoiceSession === session) {
            finishRealtimeSession('error');
        } else {
            reportVoiceSession(session);
        }
        throw error;
    }
}

/**
 * Start a voice session. Returns the ElevenLabs conversation ID if started, null otherwise.
 */
export async function startRealtimeSession(sessionId: string, initialContext?: string): Promise<string | null> {
    if (activeVoiceSession) return activeVoiceSession.conversationId;
    if (!voiceSession) {
        console.warn('No voice session registered');
        return null;
    }

    // Show connecting state immediately so the user sees feedback
    storage.getState().setRealtimeStatus('connecting');

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        storage.getState().setRealtimeStatus('disconnected');
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return null;
    }

    try {
        // Bypass Happy server token — only when user has their own custom agent
        const { voiceBypassToken, voiceCustomAgentId } = storage.getState().settings;
        if (voiceBypassToken && voiceCustomAgentId) {
            console.log('[Voice] Bypassing token, custom agent ID:', voiceCustomAgentId);
            return await startVoiceSession(voiceSession, {
                sessionId,
                initialContext,
                agentId: voiceCustomAgentId,
            });
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            storage.getState().setRealtimeStatus('disconnected');
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return null;
        }

        const response = await fetchVoiceCredentials(credentials, sessionId);
        console.log('[Voice] fetchVoiceCredentials response:', response);

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
            console.log('[Voice] Must-pay paywall result:', result);
            if (result.purchased) {
                return startRealtimeSession(sessionId, initialContext);
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
            console.log('[Voice] Soft paywall result:', result);
            // Dismissed or error — continue anyway, they can still use free tier.
        }

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

        const startedConversationId = await startVoiceSession(voiceSession, {
            sessionId,
            initialContext,
            systemPrompt,
            firstMessage,
            conversationToken: response.conversationToken,
            agentId: response.agentId,
            userId: response.elevenUserId,
        }, {
            conversationId: response.conversationId,
            incrementOnboardingPromptLoad: !hasPro && voiceUpsellVariant === 'voice-onboarding-and-upsell',
        });
        return startedConversationId;
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        storage.getState().setRealtimeStatus('disconnected');
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        return null;
    }
}

export async function stopRealtimeSession() {
    finishRealtimeSession('manual_stop');
    if (!voiceSession) {
        return;
    }

    try {
        await voiceSession.endSession();
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    }
}

export function registerVoiceSession(session: VoiceSession) {
    if (voiceSession) {
        console.warn('Voice session already registered, replacing with new one');
    }
    voiceSession = session;
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
    return activeVoiceSession?.conversationId ?? null;
}

export function getCurrentVoiceSessionDurationSeconds(): number | undefined {
    if (activeVoiceSession?.connectedAt == null) {
        return undefined;
    }
    return Math.max(0, Math.round((performance.now() - activeVoiceSession.connectedAt) / 1000));
}

export function setCurrentRealtimeSessionId(sessionId: string) {
    currentSessionId = sessionId;
}
