import type { VoiceSession } from './types';
import { fetchVoiceToken } from '@/sync/apiVoice';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { config } from '@/config';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

// Timeout for session operations to prevent hanging on poor networks
const SESSION_START_TIMEOUT_MS = 15000;

/**
 * Wraps a promise with a timeout to prevent hanging on poor network conditions.
 * This is critical for mobile users on cellular networks.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        )
    ]);
}

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
            await withTimeout(
                voiceSession.startSession({
                    sessionId,
                    initialContext,
                    agentId  // Use agentId directly, no token
                }),
                SESSION_START_TIMEOUT_MS,
                'Voice session start'
            );
            return;
        }

        // Experiments enabled = full auth flow
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return;
        }

        const response = await withTimeout(
            fetchVoiceToken(credentials, sessionId),
            SESSION_START_TIMEOUT_MS,
            'Voice token fetch'
        );
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

        if (response.token) {
            // Use token from backend
            await withTimeout(
                voiceSession.startSession({
                    sessionId,
                    initialContext,
                    token: response.token,
                    agentId: response.agentId
                }),
                SESSION_START_TIMEOUT_MS,
                'Voice session start'
            );
        } else {
            // No token (e.g. server not deployed yet) - use agentId directly
            await withTimeout(
                voiceSession.startSession({
                    sessionId,
                    initialContext,
                    agentId
                }),
                SESSION_START_TIMEOUT_MS,
                'Voice session start'
            );
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
