import type { VoiceSession } from './types';
import { fetchVoiceToken } from '@/sync/apiVoice';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { config } from '@/config';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    if (!voiceSession) {
        console.warn('No voice session registered');
        return;
    }
    
    const experimentsEnabled = storage.getState().settings.experiments;
    const agentId = __DEV__ ? config.elevenLabsAgentIdDev : config.elevenLabsAgentIdProd;
    
    if (!agentId) {
        console.error('Agent ID not configured');
        return;
    }
    
    try {
        // Simple path: No experiments = no auth needed
        if (!experimentsEnabled) {
            currentSessionId = sessionId;
            voiceSessionStarted = true;
            await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId  // Use agentId directly, no token
            });
            return;
        }
        
        // Experiments enabled = full auth flow
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return;
        }
        
        const response = await fetchVoiceToken(credentials, sessionId);
        
        if (response.allowed && response.token) {
            currentSessionId = sessionId;
            voiceSessionStarted = true;
            await voiceSession.startSession({
                sessionId,
                initialContext,
                token: response.token,  // Use token from backend
                agentId: response.agentId
            });
        } else {
            const result = await sync.presentPaywall();
            if (result.purchased) {
                await startRealtimeSession(sessionId, initialContext);
            }
        }
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