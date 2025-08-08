import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import type { VoiceSession, VoiceSessionConfig } from './types';

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
            
            
            // Use hardcoded agent ID for Eleven Labs
            await conversationInstance.startSession({
                agentId: 'agent_6701k211syvvegba4kt7m68nxjmw',
                // Pass session ID and initial context as dynamic variables
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                }
            });
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
            storage.getState().setRealtimeStatus('connected');
        },
        onDisconnect: () => {
            console.log('Realtime session disconnected');
            storage.getState().setRealtimeStatus('disconnected');
        },
        onMessage: (data) => {
            console.log('Realtime message:', data);
        },
        onError: (error) => {
            console.error('Realtime error:', error);
            storage.getState().setRealtimeStatus('error');
        },
        onStatusChange: (data) => {
            console.log('Realtime status change:', data);
        },
        onModeChange: (data) => {
            console.log('Realtime mode change:', data);
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