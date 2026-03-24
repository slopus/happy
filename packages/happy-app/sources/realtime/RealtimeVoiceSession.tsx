import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import { registerVoiceSession, getSessionVersion, setRealtimeStatusIfCurrent, setRealtimeModeIfCurrent } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;
// Version captured when startSession is called — callbacks check this to avoid stale updates
let activeVersion: number | null = null;

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {
    
    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        activeVersion = getSessionVersion();
        try {
            setRealtimeStatusIfCurrent(activeVersion, 'connecting');

            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);

            if (!config.agentId) {
                throw new Error('Agent ID not provided');
            }

            const sessionConfig: any = {
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                overrides: {
                    agent: {
                        language: elevenLabsLanguage
                    }
                },
                agentId: config.agentId
            };

            await conversationInstance.startSession(sessionConfig);
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            setRealtimeStatusIfCurrent(activeVersion, 'error');
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

    async setMicrophoneMuted(muted: boolean): Promise<void> {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }
        try {
            conversationInstance.setMicMuted(muted);
        } catch (error) {
            console.error('Failed to set mic muted state:', error);
        }
    }

    sendTextMessage(message: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversationInstance.sendUserMessage(message);
        } catch (error) {
            console.error('Failed to send text message:', error);
        }
    }

    sendContextualUpdate(update: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversationInstance.sendContextualUpdate(update);
        } catch (error) {
            console.error('Failed to send contextual update:', error);
        }
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: (data) => {
            console.log('Realtime session connected:', data);
            if (activeVersion !== null) {
                setRealtimeStatusIfCurrent(activeVersion, 'connected');
                setRealtimeModeIfCurrent(activeVersion, 'idle');
            }
        },
        onDisconnect: () => {
            console.log('Realtime session disconnected');
            if (activeVersion !== null) {
                setRealtimeStatusIfCurrent(activeVersion, 'disconnected');
                setRealtimeModeIfCurrent(activeVersion, 'idle', true);
            }
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
            if (activeVersion !== null) {
                setRealtimeStatusIfCurrent(activeVersion, 'disconnected');
                setRealtimeModeIfCurrent(activeVersion, 'idle', true);
            }
        },
        onStatusChange: (data) => {
            console.log('Realtime status change:', data);
        },
        onModeChange: (data) => {
            console.log('Realtime mode change:', data);

            // Only animate when speaking
            const mode = data.mode as string;
            const isSpeaking = mode === 'speaking';

            // Use centralized debounce logic from storage
            if (activeVersion !== null) {
                setRealtimeModeIfCurrent(activeVersion, isSpeaking ? 'speaking' : 'idle');
            }
        },
        onDebug: (message) => {
            console.debug('Realtime debug:', message);
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
