import type { VoiceSession } from './types';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getElevenLabsAgentId, getVoiceProvider } from '@/sync/voiceConfig';
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
        if (getVoiceProvider() === 'happy-voice') {
            currentSessionId = sessionId;
            voiceSessionStarted = true;
            await voiceSession.startSession({
                sessionId,
                initialContext,
            });
            return;
        }

        const agentId = getElevenLabsAgentId();

        if (!agentId) {
            console.error('Agent ID not configured');
            return;
        }

        currentSessionId = sessionId;
        voiceSessionStarted = true;

        await voiceSession.startSession({
            sessionId,
            initialContext,
            agentId,
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
        storage.getState().setMicrophoneMuted(false);
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    }
}

export async function toggleMicrophoneMute() {
    if (!voiceSession || !voiceSessionStarted) {
        return;
    }

    const currentMuted = storage.getState().microphoneMuted;
    const newMuted = !currentMuted;

    try {
        await voiceSession.setMicrophoneMuted(newMuted);
        storage.getState().setMicrophoneMuted(newMuted);
    } catch (error) {
        console.error('Failed to toggle microphone mute:', error);
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
