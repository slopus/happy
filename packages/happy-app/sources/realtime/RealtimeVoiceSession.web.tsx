import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import { registerVoiceSession, getSessionVersion, setRealtimeStatusIfCurrent, setRealtimeModeIfCurrent } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;
// Version captured when startSession is called — callbacks check this to avoid stale updates
let activeVersion: number | null = null;

// Module-level mic mute state setter (provided by React component)
let setMicMutedState: ((muted: boolean) => void) | null = null;

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        console.log('[RealtimeVoiceSessionImpl] conversationInstance:', conversationInstance);
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized - conversationInstance is null');
            return;
        }

        activeVersion = getSessionVersion();
        try {
            setRealtimeStatusIfCurrent(activeVersion, 'connecting');

            // Request microphone permission first
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                console.error('Failed to get microphone permission:', error);
                setRealtimeStatusIfCurrent(activeVersion, 'error');
                return;
            }

            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);

            if (!config.agentId) {
                throw new Error('Agent ID not provided');
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
                agentId: config.agentId
            };

            const conversationId = await conversationInstance.startSession(sessionConfig);

            console.log('Started conversation with ID:', conversationId);
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
        if (!setMicMutedState) {
            console.warn('Realtime voice session not initialized');
            return;
        }
        try {
            setMicMutedState(muted);
        } catch (error) {
            console.error('Failed to set mic muted state:', error);
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
    const [micMuted, setMicMuted] = React.useState(false);

    const conversation = useConversation({
        micMuted,
        clientTools: realtimeClientTools,
        onConnect: () => {
            console.log('Realtime session connected');
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
        console.log('[RealtimeVoiceSession] Setting conversationInstance:', conversation);
        conversationInstance = conversation;
        setMicMutedState = setMicMuted;

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
            setMicMutedState = null;
        };
    }, [conversation, setMicMuted]);

    // This component doesn't render anything visible
    return null;
};
