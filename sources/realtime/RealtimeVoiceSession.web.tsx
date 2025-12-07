import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import { registerVoiceSession } from './RealtimeSession';
import { storage, useRealtimeMicMuted } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import { fetchVoiceToken } from '@/sync/apiVoice';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Debug logging gated by environment variable
const DEBUG = !!process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
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


            // Fetch conversation token from server (private agent flow)
            const tokenResponse = await fetchVoiceToken();
            if (!tokenResponse.allowed || !tokenResponse.token) {
                console.error('Voice not allowed or no token:', tokenResponse.error);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);

            // Use conversation token from server (private agent flow)
            const conversationId = await conversationInstance.startSession({
                conversationToken: tokenResponse.token,
                connectionType: 'webrtc', // Use WebRTC for better performance
                // Pass session ID and initial context as dynamic variables
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                overrides: {
                    agent: {
                        language: elevenLabsLanguage
                    }
                }
            });

            console.log('Started conversation with ID:', conversationId);
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            storage.getState().setRealtimeStatus('error');
        }
    }

    async endSession(): Promise<void> {
        if (!conversationInstance) {
            return;
        }

        try {
            await conversationInstance.endSession();
            storage.getState().setRealtimeStatus('disconnected');
        } catch (error) {
            console.error('Failed to end realtime session:', error);
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
    // Get mic muted state from storage
    const micMuted = useRealtimeMicMuted();

    const conversation = useConversation({
        clientTools: realtimeClientTools,
        // Pass micMuted as controlled state - when true, no audio is sent to the LLM
        micMuted,
        onConnect: () => {
            if (DEBUG) console.log('[Voice] Realtime session connected');
            storage.getState().setRealtimeStatus('connected');
        },
        onDisconnect: () => {
            if (DEBUG) console.log('[Voice] Realtime session disconnected');
            storage.getState().setRealtimeStatus('disconnected');
        },
        onMessage: (data) => {
            if (DEBUG) console.log('[Voice] Realtime message:', data);
        },
        onError: (error) => {
            if (DEBUG) console.error('[Voice] Realtime error:', error);
            storage.getState().setRealtimeStatus('error');
        },
        onStatusChange: (data) => {
            if (DEBUG) console.log('[Voice] Realtime status change:', data);
        },
        onModeChange: (data) => {
            if (DEBUG) console.log('[Voice] Realtime mode change:', data);
        },
        onDebug: (message) => {
            if (DEBUG) console.debug('[Voice] Realtime debug:', message);
        }
    });

    const hasRegistered = useRef(false);

    useEffect(() => {
        // Store the conversation instance globally
        conversationInstance = conversation;

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
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