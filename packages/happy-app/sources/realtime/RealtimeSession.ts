import type { VoiceSession } from './types';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getElevenLabsAgentId, getVoiceProvider } from '@/sync/voiceConfig';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let voiceSessionStarting: boolean = false;
let startAbortController: AbortController | null = null;
let currentSessionId: string | null = null;
let sessionVersion: number = 0;

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    if (!voiceSession) {
        console.warn('No voice session registered');
        return;
    }

    // Prevent concurrent starts or starting when already started
    if (voiceSessionStarting || voiceSessionStarted) {
        console.warn('Voice session already starting or started');
        return;
    }

    // Set guards synchronously before any await to prevent race conditions
    sessionVersion++;
    const abort = new AbortController();
    startAbortController = abort;
    voiceSessionStarting = true;

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        voiceSessionStarting = false;
        if (startAbortController === abort) {
            startAbortController = null;
        }
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return;
    }

    // If stop was called during the permission check, bail out
    if (abort.signal.aborted) {
        voiceSessionStarting = false;
        if (startAbortController === abort) {
            startAbortController = null;
        }
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

            // If stop was called while we were connecting, clean up
            if (abort.signal.aborted) {
                await voiceSession.endSession();
                return;
            }
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

        // If stop was called while we were connecting, clean up
        if (abort.signal.aborted) {
            await voiceSession.endSession();
            return;
        }
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        currentSessionId = null;
        voiceSessionStarted = false;
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
    } finally {
        voiceSessionStarting = false;
        if (startAbortController === abort) {
            startAbortController = null;
        }
    }
}

export async function stopRealtimeSession() {
    // Increment version so stale callbacks from the previous session are ignored
    sessionVersion++;

    // If a start is in progress, signal it to clean up when done
    if (startAbortController) {
        startAbortController.abort();
    }

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

/**
 * Returns the current session version. Each start/stop increments this.
 * Implementations capture this at the start of a session and compare later
 * to detect stale callbacks from superseded sessions.
 */
export function getSessionVersion(): number {
    return sessionVersion;
}

/**
 * Only applies the status update if the given version matches the current session.
 * Prevents stale callbacks (e.g. a late onConnect) from flashing UI after stop.
 */
export function setRealtimeStatusIfCurrent(version: number, status: Parameters<ReturnType<typeof storage.getState>['setRealtimeStatus']>[0]): void {
    if (version !== sessionVersion) return;
    storage.getState().setRealtimeStatus(status);
}

/**
 * Only applies the mode update if the given version matches the current session.
 */
export function setRealtimeModeIfCurrent(version: number, ...args: Parameters<ReturnType<typeof storage.getState>['setRealtimeMode']>): void {
    if (version !== sessionVersion) return;
    storage.getState().setRealtimeMode(...args);
}
