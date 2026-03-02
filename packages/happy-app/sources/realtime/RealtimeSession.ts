import type { VoiceSession } from './types';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Platform } from 'react-native';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string, continuous?: boolean) {
    if (!voiceSession) {
        console.warn('No voice session registered');
        return;
    }

    // On native, request microphone permission explicitly before starting
    // On web, Web Speech API handles permissions itself (avoids lingering mic indicator)
    if (Platform.OS !== 'web') {
        const permissionResult = await requestMicrophonePermission();
        if (!permissionResult.granted) {
            showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
            return;
        }
    }

    try {
        currentSessionId = sessionId;
        voiceSessionStarted = true;
        await voiceSession.startSession({
            sessionId,
            initialContext,
            continuous,
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