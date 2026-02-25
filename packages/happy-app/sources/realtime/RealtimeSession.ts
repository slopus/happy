import type { VoiceSession, WhisperRecorder } from './types';
import { fetchVoiceToken, transcribeAudio } from '@/sync/apiVoice';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { config } from '@/config';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

// ---- ElevenLabs state (assistant mode) ----
let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;

// ---- Whisper state (dictation mode) ----
let whisperRecorder: WhisperRecorder | null = null;
let isRecording = false;

// ---- Shared state ----
let currentSessionId: string | null = null;

// Helper: read current voice mode from settings
function getVoiceMode(): 'assistant' | 'dictation' {
    return storage.getState().settings.voiceMode ?? 'assistant';
}

// ---- Registration ----

export function registerVoiceSession(session: VoiceSession) {
    if (voiceSession) {
        console.warn('Voice session already registered, replacing with new one');
    }
    voiceSession = session;
}

export function registerWhisperRecorder(rec: WhisperRecorder) {
    whisperRecorder = rec;
}

// ---- ElevenLabs: assistant mode ----

async function startAssistantSession(sessionId: string, initialContext?: string) {
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
            await voiceSession.startSession({
                sessionId,
                initialContext,
                token: response.token,
                agentId: response.agentId
            });
        } else {
            // No token (e.g. server not deployed yet) - use agentId directly
            await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId
            });
        }
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        currentSessionId = null;
        voiceSessionStarted = false;
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
    }
}

async function stopAssistantSession() {
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

// ---- Whisper: dictation mode ----

async function startDictationRecording(sessionId: string) {
    if (isRecording) {
        console.warn('[Voice] Already recording');
        return;
    }

    if (!whisperRecorder) {
        console.error('[Voice] No whisper recorder registered');
        return;
    }

    try {
        currentSessionId = sessionId;
        isRecording = true;
        storage.getState().setRealtimeStatus('connected');
        storage.getState().setRealtimeMode('speaking');
        await whisperRecorder.start();
        console.log('[Voice] Recording started');
    } catch (error) {
        console.error('[Voice] Failed to start recording:', error);
        isRecording = false;
        currentSessionId = null;
        storage.getState().setRealtimeStatus('error');
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
    }
}

// Core: stop recorder + transcribe, returns text (or null on error/empty)
async function stopDictationAndTranscribe(): Promise<{ sessionId: string; text: string } | null> {
    if (!isRecording || !whisperRecorder || !currentSessionId) {
        console.warn('[Voice] Not recording');
        return null;
    }

    const sessionId = currentSessionId;

    try {
        // Stop recording — get audio file URI
        isRecording = false;
        storage.getState().setRealtimeStatus('connecting'); // "Transcribing..."
        storage.getState().setRealtimeMode('idle');

        const audioUri = await whisperRecorder.stop();
        console.log('[Voice] Recording stopped, audio URI:', audioUri);

        // Send to Whisper for transcription
        const result = await transcribeAudio(audioUri);
        console.log('[Voice] Transcription result:', result.text);

        if (!result.text || !result.text.trim()) {
            console.warn('[Voice] Whisper returned empty text');
            storage.getState().setRealtimeStatus('disconnected');
            return null;
        }

        storage.getState().setRealtimeStatus('disconnected');
        return { sessionId, text: result.text.trim() };
    } catch (error) {
        console.error('[Voice] Transcription failed:', error);
        storage.getState().setRealtimeStatus('error');
        const msg = error instanceof Error ? error.message : String(error);
        Modal.alert(t('common.error'), `Voice failed: ${msg}`);
        // Auto-clear error after 5 seconds
        setTimeout(() => {
            if (storage.getState().realtimeStatus === 'error') {
                storage.getState().setRealtimeStatus('disconnected');
            }
        }, 5000);
        return null;
    } finally {
        currentSessionId = null;
    }
}

// Stop + transcribe + send message immediately
async function stopDictationAndSend() {
    const result = await stopDictationAndTranscribe();
    if (result) {
        await sync.sendMessage(result.sessionId, result.text);
    }
}

// Stop + transcribe + put text into the input field (via pendingTranscription)
async function stopDictationToInput() {
    const result = await stopDictationAndTranscribe();
    if (result) {
        storage.getState().setPendingTranscription(result.text);
    }
}

// ---- Public API (delegates based on voice mode) ----

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return;
    }

    if (getVoiceMode() === 'dictation') {
        await startDictationRecording(sessionId);
    } else {
        await startAssistantSession(sessionId, initialContext);
    }
}

export async function stopRealtimeSession() {
    if (getVoiceMode() === 'dictation') {
        if (isRecording) {
            await stopDictationToInput(); // Banner tap → fill text input
        }
    } else {
        await stopAssistantSession();
    }
}

// Dictation only: stop recording + transcribe + send immediately (send button path)
export async function sendDictationNow() {
    if (isRecording) {
        await stopDictationAndSend();
    }
}

// ---- Accessors (used by voiceHooks, storage, status bar) ----

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

export function isVoiceRecording(): boolean {
    return isRecording;
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSession;
}

export function getCurrentRealtimeSessionId(): string | null {
    return currentSessionId;
}
