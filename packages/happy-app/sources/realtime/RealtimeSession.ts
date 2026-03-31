import type { VoiceSession } from './types';
import { fetchVoiceToken } from '@/sync/apiVoice';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import { config } from '@/config';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    if (!voiceSession) {
        console.warn('No voice session registered');
        return;
    }

    // Show connecting state immediately so the user sees feedback
    storage.getState().setRealtimeStatus('connecting');

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        storage.getState().setRealtimeStatus('disconnected');
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return;
    }

    try {
        // Bypass Happy server token when enabled
        const { voiceBypassToken, voiceCustomAgentId } = storage.getState().settings;
        if (voiceBypassToken) {
            const agentId = voiceCustomAgentId || config.elevenLabsAgentId;
            if (!agentId) {
                storage.getState().setRealtimeStatus('disconnected');
                Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                return;
            }
            console.log('[Voice] Bypassing token, agent ID:', agentId);
            currentSessionId = sessionId;
            voiceSessionStarted = true;
            await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId,
            });
            return;
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            storage.getState().setRealtimeStatus('disconnected');
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return;
        }

        const response = await fetchVoiceToken(credentials, sessionId);
        console.log('[Voice] fetchVoiceToken response:', response);

        if (!response.allowed) {
            storage.getState().setRealtimeStatus('disconnected');
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
        storage.getState().setRealtimeStatus('disconnected');
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
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    } finally {
        currentSessionId = null;
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

export function setCurrentRealtimeSessionId(sessionId: string) {
    currentSessionId = sessionId;
}