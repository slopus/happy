import React, { useLayoutEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import { notifyVoiceSessionDisconnected, registerVoiceSession, resetVoiceProviderAndWait, unregisterVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { RealtimeVoiceSessionAdapter } from './RealtimeVoiceSessionAdapter';

const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;

export const RealtimeVoiceSession: React.FC = () => {
    const adapterRef = useRef<RealtimeVoiceSessionAdapter | null>(null);
    const vadSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const agentIsSpeakingRef = useRef(false);
    if (!adapterRef.current) {
        adapterRef.current = new RealtimeVoiceSessionAdapter(
            resetVoiceProviderAndWait,
        );
    }

    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: ({ conversationId }) => {
            console.log('[Voice] Realtime session connected:', conversationId);
            adapterRef.current?.handleConnect(conversationId);
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
        },
        onDisconnect: (details) => {
            console.log('[Voice] Realtime session disconnected:', details);
            adapterRef.current?.handleDisconnect(
                details.reason === 'error' ? details.message : undefined,
            );
            notifyVoiceSessionDisconnected();
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
        },
        onMessage: (data) => {
            console.log('[Voice] Realtime message:', data);
        },
        onError: (message, context) => {
            console.warn('[Voice] Realtime error:', message, context);
            const startFailed = adapterRef.current?.handleError(message) ?? false;
            if (startFailed) {
                storage.getState().setRealtimeStatus('error');
                storage.getState().setRealtimeMode('idle', true);
            }
        },
        onStatusChange: (data) => {
            console.log('[Voice] Realtime status change:', data);
        },
        onModeChange: ({ mode }) => {
            agentIsSpeakingRef.current = mode === 'speaking';
            storage.getState().setRealtimeMode(
                agentIsSpeakingRef.current ? 'agent-speaking' : 'idle',
            );
        },
        onVadScore: ({ vadScore }) => {
            if (agentIsSpeakingRef.current) return;

            if (vadScore > VAD_THRESHOLD) {
                if (vadSilenceTimerRef.current) {
                    clearTimeout(vadSilenceTimerRef.current);
                    vadSilenceTimerRef.current = null;
                }
                storage.getState().setRealtimeMode('user-speaking', true);
            } else if (!vadSilenceTimerRef.current) {
                vadSilenceTimerRef.current = setTimeout(() => {
                    vadSilenceTimerRef.current = null;
                    if (!agentIsSpeakingRef.current) {
                        storage.getState().setRealtimeMode('idle');
                    }
                }, VAD_SILENCE_MS);
            }
        },
        onDebug: (message) => {
            console.debug('[Voice] Realtime debug:', message);
        },
    });

    adapterRef.current.setConversation(conversation);

    useLayoutEffect(() => {
        const adapter = adapterRef.current!;
        // Strict Mode replays layout-effect cleanup/setup without a render in
        // between, so restore the controller after a cleanup disposed it.
        adapter.setConversation(conversation);
        registerVoiceSession(adapter);
        return () => {
            unregisterVoiceSession(adapter);
            adapter.dispose();
            if (vadSilenceTimerRef.current) {
                clearTimeout(vadSilenceTimerRef.current);
                vadSilenceTimerRef.current = null;
            }
        };
    }, []);

    return null;
};
