import type { VoiceSession } from './types';
import { fetchVoiceToken } from '@/sync/apiVoice';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    if (!voiceSession) {
        console.warn('No voice session registered');
        return;
    }

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return;
    }

    try {
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return;
        }

        const response = await fetchVoiceToken(credentials, sessionId);
        console.log('[Voice] fetchVoiceToken response:', response);

        if (!response.allowed) {
            console.log('[Voice] Not allowed, presenting paywall...');
            const result = await sync.presentPaywall();
            console.log('[Voice] Paywall result:', result);
            if (result.purchased) {
                await startRealtimeSession(sessionId, initialContext);
            }
            return;
        }

        currentSessionId = sessionId;
        voiceSessionStarted = true;

        await voiceSession.startSession({
            sessionId,
            initialContext,
            token: response.token,
            agentId: response.agentId,
            userId: response.elevenUserId,
        });
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        currentSessionId = null;
        voiceSessionStarted = false;
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
    }
}

export async function stopRealtimeSession() {
    if (!voiceSession) {
        return;
    }
    
    try {
        await voiceSession.endSession();
        currentSessionId = null;
        voiceSessionStarted = false;
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