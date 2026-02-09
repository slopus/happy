import React, { useEffect, useRef } from 'react';
import { registerGlobals } from '@livekit/react-native';
import { Room, RoomEvent } from 'livekit-client';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { getCurrentLanguage } from '@/text';
import {
    sendHappyVoiceContext,
    sendHappyVoiceText,
    startHappyVoiceSession,
    stopHappyVoiceSession,
} from '@/sync/apiHappyVoice';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { serializeHappyVoiceContext } from './HappyVoiceContextSerializer';

registerGlobals();

let roomInstance: Room | null = null;
let activeGatewaySessionId: string | null = null;

class HappyVoiceSessionImpl implements VoiceSession {
    async startSession(config: VoiceSessionConfig): Promise<void> {
        try {
            storage.getState().setRealtimeStatus('connecting');

            const current = roomInstance;
            if (current) {
                await current.disconnect();
                roomInstance = null;
            }

            const language = getCurrentLanguage();
            const initialContextPayload = config.initialContext
                ? serializeHappyVoiceContext(config.initialContext)
                : undefined;
            const start = await startHappyVoiceSession(
                config.sessionId,
                initialContextPayload,
                language,
            );

            const room = new Room({
                adaptiveStream: true,
                dynacast: true,
            });

            room.on(RoomEvent.Disconnected, () => {
                storage.getState().setRealtimeStatus('disconnected');
                storage.getState().setRealtimeMode('idle', true);
                storage.getState().clearRealtimeModeDebounce();
            });

            room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
                const remoteSpeaking = speakers.some(
                    (speaker) => speaker.identity !== room.localParticipant.identity,
                );
                storage.getState().setRealtimeMode(remoteSpeaking ? 'speaking' : 'idle');
            });

            await room.connect(start.roomUrl, start.participantToken);
            await room.localParticipant.setMicrophoneEnabled(true);

            roomInstance = room;
            activeGatewaySessionId = start.gatewaySessionId;
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle', true);
        } catch (error) {
            console.error('[HappyVoice] Failed to start session:', error);
            storage.getState().setRealtimeStatus('error');
        }
    }

    async endSession(): Promise<void> {
        const gatewaySessionId = activeGatewaySessionId;
        activeGatewaySessionId = null;

        try {
            if (roomInstance) {
                await roomInstance.disconnect();
                roomInstance = null;
            }
        } catch (error) {
            console.warn('[HappyVoice] Room disconnect failed:', error);
        }

        if (gatewaySessionId) {
            stopHappyVoiceSession(gatewaySessionId).catch((error) => {
                console.warn('[HappyVoice] Failed to stop gateway session:', error);
            });
        }

        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
        storage.getState().clearRealtimeModeDebounce();
    }

    sendTextMessage(message: string): void {
        const gatewaySessionId = activeGatewaySessionId;
        if (!gatewaySessionId) {
            console.warn('[HappyVoice] No active gateway session for text');
            return;
        }

        sendHappyVoiceText(gatewaySessionId, message).catch((error) => {
            console.warn('[HappyVoice] Failed to send text update:', error);
        });
    }

    sendContextualUpdate(update: string): void {
        const gatewaySessionId = activeGatewaySessionId;
        if (!gatewaySessionId) {
            console.warn('[HappyVoice] No active gateway session for context');
            return;
        }

        const payload = serializeHappyVoiceContext(update);
        sendHappyVoiceContext(gatewaySessionId, payload).catch((error) => {
            console.warn('[HappyVoice] Failed to send context update:', error);
        });
    }
}

export const HappyVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            registerVoiceSession(new HappyVoiceSessionImpl());
            hasRegistered.current = true;
        }
    }, []);

    return null;
};
