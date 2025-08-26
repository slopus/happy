import type { VoiceSession } from './types';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    if (!voiceSession) {
        console.warn('No voice session registered');
        return;
    }
    
    try {
        currentSessionId = sessionId;
        voiceSessionStarted = true;
        await voiceSession.startSession({
            sessionId,
            initialContext
        });
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        currentSessionId = null;
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

export function updateCurrentSessionId(sessionId: string | null) {
    console.log(`🔄 Realtime session ID updated: ${sessionId}`);
    currentSessionId = sessionId;
}