import React, { useEffect, useRef } from 'react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { VoiceSession, VoiceSessionConfig } from './types';

// SpeechRecognition types for web
interface SpeechRecognitionEvent {
    resultIndex: number;
    results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
    length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
    isFinal: boolean;
    length: number;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
    transcript: string;
    confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;
    onspeechstart: (() => void) | null;
    onspeechend: (() => void) | null;
}

declare global {
    interface Window {
        SpeechRecognition: new () => SpeechRecognitionInstance;
        webkitSpeechRecognition: new () => SpeechRecognitionInstance;
    }
}

// Active recognition state
let recognition: SpeechRecognitionInstance | null = null;
let activeSessionId: string | null = null;
let isContinuousMode: boolean = false;
let stoppedByUser: boolean = false;

function cleanupState() {
    activeSessionId = null;
    recognition = null;
    isContinuousMode = false;
    stoppedByUser = false;
    storage.getState().setVoiceContinuous(false);
    storage.getState().setRealtimeStatus('disconnected');
    storage.getState().setRealtimeMode('idle', true);
}

class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.error('[WebSpeech] Not supported in this browser');
            storage.getState().setRealtimeStatus('error');
            return;
        }

        try {
            storage.getState().setRealtimeStatus('connecting');
            isContinuousMode = config.continuous ?? false;
            stoppedByUser = false;
            storage.getState().setVoiceContinuous(isContinuousMode);

            activeSessionId = config.sessionId;

            recognition = new SpeechRecognition();
            recognition.continuous = true; // Always continuous — we control stop ourselves
            recognition.interimResults = true; // Show interim for visual feedback

            // Get user's preferred language, default to Russian
            const userLang = storage.getState().settings.voiceAssistantLanguage;
            recognition.lang = userLang || 'ru-RU';

            console.log('[WebSpeech] Starting, mode:', isContinuousMode ? 'continuous' : 'tap', 'lang:', recognition.lang);

            recognition.onstart = () => {
                console.log('[WebSpeech] Recognition started');
                storage.getState().setRealtimeStatus('connected');
                storage.getState().setRealtimeMode('idle');
            };

            recognition.onspeechstart = () => {
                storage.getState().setRealtimeMode('speaking');
            };

            recognition.onspeechend = () => {
                storage.getState().setRealtimeMode('idle');
            };

            // Tap mode: accumulate text, send after silence pause
            let tapBuffer = '';
            let tapSendTimer: ReturnType<typeof setTimeout> | null = null;
            let tapSent = false;

            recognition.onresult = (event: SpeechRecognitionEvent) => {
                // Ignore results after tap mode already sent
                if (!isContinuousMode && tapSent) return;

                let finalTranscript = '';

                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const result = event.results[i];
                    if (result.isFinal) {
                        finalTranscript += result[0].transcript;
                    }
                }

                if (!finalTranscript.trim()) return;

                console.log('[WebSpeech] Final transcript:', finalTranscript.trim());

                if (isContinuousMode) {
                    // Continuous mode: accumulate in input field, user sends manually
                    storage.getState().appendVoiceTranscript(finalTranscript.trim());
                } else {
                    // Tap mode: accumulate and send after 1.5s silence
                    tapBuffer += (tapBuffer ? ' ' : '') + finalTranscript.trim();

                    // Update input field as preview
                    storage.getState().clearVoiceTranscript();
                    storage.getState().appendVoiceTranscript(tapBuffer);

                    // Reset the send timer
                    if (tapSendTimer) clearTimeout(tapSendTimer);
                    tapSendTimer = setTimeout(() => {
                        if (tapBuffer.trim() && activeSessionId && !tapSent) {
                            tapSent = true;
                            console.log('[WebSpeech] Tap mode: sending after pause:', tapBuffer.trim());
                            sync.sendMessage(activeSessionId, tapBuffer.trim(), undefined, undefined, 'voice');
                            tapBuffer = '';
                            storage.getState().clearVoiceTranscript();
                        }
                        // Abort recognition immediately (releases mic faster)
                        stoppedByUser = true;
                        recognition?.abort();
                    }, 1500);
                }
            };

            recognition.onerror = (event: { error: string }) => {
                console.warn('[WebSpeech] Error:', event.error);
                // Ignore transient errors
                if (event.error === 'no-speech' || event.error === 'aborted') {
                    return;
                }
                storage.getState().setRealtimeStatus('error');
            };

            recognition.onend = () => {
                console.log('[WebSpeech] Recognition ended, continuous:', isContinuousMode, 'stoppedByUser:', stoppedByUser);

                if (!stoppedByUser && activeSessionId) {
                    // Browser stopped recognition on its own (e.g. long silence)
                    if (isContinuousMode) {
                        // Continuous mode: auto-restart
                        console.log('[WebSpeech] Auto-restarting (continuous mode)');
                        try {
                            recognition?.start();
                            return;
                        } catch (e) {
                            console.warn('[WebSpeech] Failed to restart:', e);
                        }
                    } else {
                        // Tap mode: browser stopped before timer fired
                        // Send whatever we have and clean up
                        if (tapBuffer.trim() && activeSessionId && !tapSent) {
                            tapSent = true;
                            console.log('[WebSpeech] Tap mode: sending on unexpected end:', tapBuffer.trim());
                            sync.sendMessage(activeSessionId, tapBuffer.trim(), undefined, undefined, 'voice');
                            tapBuffer = '';
                            storage.getState().clearVoiceTranscript();
                        }
                        if (tapSendTimer) {
                            clearTimeout(tapSendTimer);
                            tapSendTimer = null;
                        }
                    }
                }

                // Clear timer if pending
                if (tapSendTimer) {
                    clearTimeout(tapSendTimer);
                    tapSendTimer = null;
                }

                // Full cleanup
                cleanupState();
            };

            recognition.start();
        } catch (error) {
            console.error('[WebSpeech] Failed to start:', error);
            cleanupState();
        }
    }

    async endSession(): Promise<void> {
        console.log('[WebSpeech] endSession called');
        stoppedByUser = true;

        if (recognition) {
            try {
                recognition.abort();
            } catch (e) {
                // Ignore
            }
            recognition = null;
        }

        cleanupState();
    }

    sendTextMessage(_message: string): void {
        // Not used with Web Speech API
    }

    sendContextualUpdate(_update: string): void {
        // Not used with Web Speech API
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                console.log('[RealtimeVoiceSession] Registering Web Speech API voice session');
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
            } catch (error) {
                console.error('Failed to register voice session:', error);
            }
        }

        return () => {
            stoppedByUser = true;
            if (recognition) {
                recognition.abort();
                recognition = null;
            }
        };
    }, []);

    return null;
};
