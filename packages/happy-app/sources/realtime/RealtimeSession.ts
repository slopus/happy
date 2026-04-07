import type { VoiceSession } from './types';
import { fetchVoiceSignedUrl } from '@/sync/apiVoice';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import { config } from '@/config';
import { getVoiceSoftPaywallShownCount, incrementVoiceSoftPaywallShown } from '@/sync/persistence';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;
let currentVoiceConversationId: string | null = null;

/**
 * Start a voice session. Returns the ElevenLabs conversation ID if started, null otherwise.
 */
export async function startRealtimeSession(sessionId: string, initialContext?: string): Promise<string | null> {
    currentVoiceConversationId = null;

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
            currentSessionId = sessionId;
            const conversationId = await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId: voiceCustomAgentId,
            });
            currentVoiceConversationId = conversationId;
            voiceSessionStarted = true;
            return conversationId;
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            storage.getState().setRealtimeStatus('disconnected');
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return null;
        }

        const response = await fetchVoiceSignedUrl(credentials, sessionId);
        console.log('[Voice] fetchVoiceSignedUrl response:', response);

        if (!response.allowed) {
            storage.getState().setRealtimeStatus('disconnected');

            // Server hard-declined — must pay to continue
            console.log('[Voice] Not allowed (reason: %s), presenting must-pay paywall...', response.reason);
            const result = await sync.presentPaywall('voice_must_pay');
            console.log('[Voice] Must-pay paywall result:', result);
            if (result.purchased) {
                return startRealtimeSession(sessionId, initialContext);
            }
            return null;
        }

        // Show soft paywall once per device for free-tier users on first successful voice use
        const hasPro = storage.getState().purchases.entitlements['pro'] ?? false;
        if (!hasPro && getVoiceSoftPaywallShownCount() < 1) {
            console.log('[Voice] First voice attempt on free tier, showing soft paywall...');
            incrementVoiceSoftPaywallShown();
            const result = await sync.presentPaywall('voice_trial_eligible');
            console.log('[Voice] Soft paywall result:', result);
            // Dismissed or error — continue anyway, they can still use free tier
        }

        currentSessionId = sessionId;

        const startedConversationId = await voiceSession.startSession({
            sessionId,
            initialContext,
            signedUrl: response.signedUrl,
            agentId: response.agentId,
            userId: response.elevenUserId,
        });
        currentVoiceConversationId = response.conversationId ?? startedConversationId;
        voiceSessionStarted = true;
        return currentVoiceConversationId;
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        storage.getState().setRealtimeStatus('disconnected');
        currentSessionId = null;
        currentVoiceConversationId = null;
        voiceSessionStarted = false;
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        return null;
    }
}

export async function stopRealtimeSession() {
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
        voiceSessionStarted = false;
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
    return currentVoiceConversationId;
}

export function setCurrentRealtimeSessionId(sessionId: string) {
    currentSessionId = sessionId;
}
