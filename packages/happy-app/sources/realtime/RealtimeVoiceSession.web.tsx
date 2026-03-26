import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// VAD state for user speech detection
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let agentIsSpeaking = false;

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        console.log('[RealtimeVoiceSessionImpl] conversationInstance:', conversationInstance);
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized - conversationInstance is null');
            return;
        }

        try {
            storage.getState().setRealtimeStatus('connecting');

            // Request microphone permission first
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                console.error('Failed to get microphone permission:', error);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);
            
            if (!config.token && !config.agentId) {
                throw new Error('Neither token nor agentId provided');
            }
            
            const sessionConfig: any = {
                connectionType: 'webrtc',
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                overrides: {
                    agent: {
                        language: elevenLabsLanguage
                    }
                },
                ...(config.token ? { conversationToken: config.token } : { agentId: config.agentId }),
                ...(config.userId ? { userId: config.userId } : {}),
            };
            
            const conversationId = await conversationInstance.startSession(sessionConfig);

            console.log('Started conversation with ID:', conversationId);
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            storage.getState().setRealtimeStatus('error');
        }
    }

    async endSession(): Promise<void> {
        if (!conversationInstance) {
            storage.getState().setRealtimeStatus('disconnected');
            return;
        }

        try {
            await conversationInstance.endSession();
        } catch (error) {
            console.error('Failed to end realtime session:', error);
        } finally {
            storage.getState().setRealtimeStatus('disconnected');
        }
    }

    sendTextMessage(message: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversationInstance.sendUserMessage(message);
    }

    sendContextualUpdate(update: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversationInstance.sendContextualUpdate(update);
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: () => {
            console.log('Realtime session connected');
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
        },
        onDisconnect: () => {
            console.log('Realtime session disconnected');
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
            storage.getState().clearRealtimeModeDebounce();
        },
        onMessage: (data) => {
            console.log('Realtime message:', data);
        },
        onError: (error) => {
            // Log but don't block app - voice features will be unavailable
            // This prevents initialization errors from showing "Terminals error" on startup
            console.warn('Realtime voice not available:', error);
            // Don't set error status during initialization - just set disconnected
            // This allows the app to continue working without voice features
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
        },
        onStatusChange: (data) => {
            console.log('Realtime status change:', data);
        },
        onModeChange: (data) => {
            console.log('Realtime mode change:', data);

            const mode = data.mode as string;
            agentIsSpeaking = mode === 'speaking';

            if (agentIsSpeaking) {
                storage.getState().setRealtimeMode('agent-speaking');
            } else {
                storage.getState().setRealtimeMode('idle');
            }
        },
        onVadScore: (data) => {
            const { vadScore } = data;
            if (agentIsSpeaking) return;

            if (vadScore > VAD_THRESHOLD) {
                if (vadSilenceTimer) {
                    clearTimeout(vadSilenceTimer);
                    vadSilenceTimer = null;
                }
                storage.getState().setRealtimeMode('user-speaking', true);
            } else {
                if (!vadSilenceTimer) {
                    vadSilenceTimer = setTimeout(() => {
                        vadSilenceTimer = null;
                        if (!agentIsSpeaking) {
                            storage.getState().setRealtimeMode('idle');
                        }
                    }, VAD_SILENCE_MS);
                }
            }
        },
        onDebug: (message) => {
            console.debug('Realtime debug:', message);
        }
    });

    const hasRegistered = useRef(false);

    useEffect(() => {
        // Store the conversation instance globally
        console.log('[RealtimeVoiceSession] Setting conversationInstance:', conversation);
        conversationInstance = conversation;

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                console.log('[RealtimeVoiceSession] Registering voice session');
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
                console.log('[RealtimeVoiceSession] Voice session registered successfully');
            } catch (error) {
                console.error('Failed to register voice session:', error);
            }
        }

        return () => {
            // Clean up on unmount
            conversationInstance = null;
        };
    }, [conversation]);

    // This component doesn't render anything visible
    return null;
};