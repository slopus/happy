import React, { useEffect, useRef } from 'react';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { OpenAIRealtimeClient } from './openai/OpenAIRealtimeClient';
import { buildSystemPrompt } from './openai/systemPrompt';
import { OPENAI_TOOL_DEFINITIONS } from './openai/toolTranslator';
import { getSessionLabel } from './hooks/contextFormatters';
import { config } from '@/config';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Global client reference
let clientInstance: OpenAIRealtimeClient | null = null;

class OpenAIVoiceSessionImpl implements VoiceSession {

    async startSession(sessionConfig: VoiceSessionConfig): Promise<void> {
        if (!clientInstance) {
            console.warn('[OpenAIVoiceSession.web] Client not initialized');
            return;
        }

        try {
            storage.getState().setRealtimeStatus('connecting');

            // Request mic permission on web
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                console.error('[OpenAIVoiceSession.web] Mic permission denied:', error);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            const instructions = buildSystemPrompt(sessionConfig.initialContext || '');
            const voice = config.openAiRealtimeVoice || 'alloy';
            const model = config.openAiRealtimeModel || undefined;

            await clientInstance.connect({
                clientSecret: sessionConfig.clientSecret,
                apiKey: sessionConfig.apiKey || config.openAiApiKey,
                model,
                instructions,
                tools: OPENAI_TOOL_DEFINITIONS,
                voice,
                vadType: 'semantic_vad',
                vadEagerness: 'low',
            });
        } catch (error) {
            console.error('[OpenAIVoiceSession.web] Failed to start:', error);
            storage.getState().setRealtimeStatus('error');
        }
    }

    async endSession(): Promise<void> {
        clientInstance?.disconnect();
        storage.getState().setRealtimeStatus('disconnected');
    }

    sendTextMessage(message: string): void {
        clientInstance?.sendMessage(message);
    }

    sendContextualUpdate(update: string): void {
        clientInstance?.injectContext(update);
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        // Web uses browser-native RTCPeerConnection — no override needed
        clientInstance = new OpenAIRealtimeClient(
            {
                onConnect: () => {
                    console.log('[OpenAIVoiceSession.web] Connected');
                    storage.getState().setRealtimeStatus('connected');
                    storage.getState().setRealtimeMode('idle');

                    // Send session roster after connect
                    try {
                        const active = storage.getState().getActiveSessions();
                        if (active.length > 0 && clientInstance) {
                            const roster = active.map(s => {
                                const label = getSessionLabel(s);
                                const summary = s.metadata?.summary?.text || 'no summary yet';
                                const status = s.active ? 'online' : 'offline';
                                return `- "${label}" (${status}): ${summary}`;
                            }).join('\n');
                            clientInstance.injectContext(
                                `ACTIVE SESSIONS:\n${roster}\n\nUse these session names when calling tools.`
                            );
                        }
                    } catch (error) {
                        console.warn('[OpenAIVoiceSession.web] Failed to send roster:', error);
                    }
                },
                onDisconnect: (reason) => {
                    console.log('[OpenAIVoiceSession.web] Disconnected:', reason);
                    storage.getState().setRealtimeStatus('disconnected');
                    storage.getState().setRealtimeMode('idle', true);
                    storage.getState().clearRealtimeModeDebounce();
                },
                onModeChange: (mode) => {
                    storage.getState().setRealtimeMode(mode === 'speaking' ? 'speaking' : 'idle');
                },
                onError: (error) => {
                    console.warn('[OpenAIVoiceSession.web] Error:', error);
                    storage.getState().setRealtimeStatus('disconnected');
                    storage.getState().setRealtimeMode('idle', true);
                },
            }
        );

        if (!hasRegistered.current) {
            registerVoiceSession(new OpenAIVoiceSessionImpl());
            hasRegistered.current = true;
        }

        return () => {
            clientInstance?.disconnect();
            clientInstance = null;
        };
    }, []);

    return null;
};
