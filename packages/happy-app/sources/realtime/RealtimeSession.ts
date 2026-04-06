import type { VoiceSession } from './types';
import { fetchVoiceToken } from '@/sync/apiVoice';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { config } from '@/config';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

async function startElevenLabsSession(sessionId: string, initialContext?: string) {
    if (!voiceSession) return;

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
}

async function startOpenAISession(sessionId: string, initialContext?: string) {
    if (!voiceSession) return;

    const apiKey = storage.getState().settings.inferenceOpenAIKey;

    if (!apiKey) {
        console.error('[Voice] OpenAI API key not configured');
        storage.getState().setRealtimeStatus('disconnected');
        Modal.alert(t('common.error'), 'OpenAI API key not configured. Add your key in Settings > Voice.');
        return;
    }

    const pushToTalk = storage.getState().settings.voicePushToTalk;

    currentSessionId = sessionId;
    voiceSessionStarted = true;
    await voiceSession.startSession({
        sessionId,
        initialContext,
        apiKey,
        pushToTalk,
    });
}

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

    const voiceBackend = storage.getState().settings.voiceBackend;

    try {
        if (voiceBackend === 'openai') {
            await startOpenAISession(sessionId, initialContext);
        } else {
            await startElevenLabsSession(sessionId, initialContext);
        }
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

export function startTalking(): void {
    voiceSession?.startTalking();
}

export function stopTalking(): void {
    voiceSession?.stopTalking();
}

export function isPushToTalkEnabled(): boolean {
    const settings = storage.getState().settings;
    return settings.voiceBackend === 'openai' && settings.voicePushToTalk;
}
