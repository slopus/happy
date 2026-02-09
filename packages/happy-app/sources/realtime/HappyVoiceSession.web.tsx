import React, { useEffect, useRef } from 'react';
import { Room, RoomEvent, type RemoteTrack } from 'livekit-client';
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

let roomInstance: Room | null = null;
let activeGatewaySessionId: string | null = null;

function attachRemoteAudioTrack(track: RemoteTrack) {
    if (track.kind !== 'audio') {
        return;
    }

    const element = track.attach();
    if (element instanceof HTMLAudioElement) {
        element.autoplay = true;
        element.style.display = 'none';
        document.body.appendChild(element);
    }
}

function detachRemoteAudioTrack(track: RemoteTrack) {
    if (track.kind !== 'audio') {
        return;
    }

    const elements = track.detach();
    for (const element of elements) {
        element.remove();
    }
}

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
            room.on(RoomEvent.TrackSubscribed, (track) => {
                attachRemoteAudioTrack(track as RemoteTrack);
            });
            room.on(RoomEvent.TrackUnsubscribed, (track) => {
                detachRemoteAudioTrack(track as RemoteTrack);
            });

            await room.connect(start.roomUrl, start.participantToken);
            await room.localParticipant.setMicrophoneEnabled(true);
            try {
                await room.startAudio();
            } catch (error) {
                console.warn('[HappyVoice] Failed to start remote audio playback:', error);
            }

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
