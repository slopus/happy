import React, { useEffect, useRef } from 'react';
import { Room, RoomEvent, type RemoteTrack } from 'livekit-client';
import { registerVoiceSession, getSessionVersion, setRealtimeStatusIfCurrent, setRealtimeModeIfCurrent } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { getCurrentLanguage } from '@/text';
import {
    sendHappyVoiceContext,
    sendHappyVoiceText,
    startHappyVoiceSession,
    stopHappyVoiceSession,
} from '@/sync/apiHappyVoice';
import { getWelcomeMessage } from '@/sync/voiceConfig';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { serializeHappyVoiceContext } from './HappyVoiceContextSerializer';

let roomInstance: Room | null = null;
let activeGatewaySessionId: string | null = null;
let thinkingTimeoutId: ReturnType<typeof setTimeout> | null = null;
const THINKING_TIMEOUT_MS = 15000;

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
        const version = getSessionVersion();
        try {
            setRealtimeStatusIfCurrent(version, 'connecting');

            const current = roomInstance;
            if (current) {
                await current.disconnect();
                roomInstance = null;
            }

            const language = storage.getState().settings.voiceAssistantLanguage || getCurrentLanguage();
            const initialContextPayload = config.initialContext
                ? serializeHappyVoiceContext(config.initialContext)
                : undefined;
            const welcomeMessage = getWelcomeMessage();
            const start = await startHappyVoiceSession(
                config.sessionId,
                initialContextPayload,
                language,
                welcomeMessage,
            );

            const room = new Room({
                adaptiveStream: true,
                dynacast: true,
            });

            room.on(RoomEvent.Disconnected, () => {
                if (thinkingTimeoutId) { clearTimeout(thinkingTimeoutId); thinkingTimeoutId = null; }
                setRealtimeStatusIfCurrent(version, 'disconnected');
                setRealtimeModeIfCurrent(version, 'idle', true);
                storage.getState().clearRealtimeModeDebounce();
            });

            room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
                const remoteSpeaking = speakers.some(
                    (speaker) => speaker.identity !== room.localParticipant.identity,
                );
                setRealtimeModeIfCurrent(version, remoteSpeaking ? 'speaking' : 'idle');
            });

            room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic) => {
                if (topic !== 'happy.voice.agent-state') return;
                try {
                    const data = JSON.parse(new TextDecoder().decode(payload));
                    if (data.state === 'thinking') {
                        setRealtimeModeIfCurrent(version, 'thinking', true);
                        // Timeout fallback: clear thinking if no follow-up state arrives
                        if (thinkingTimeoutId) clearTimeout(thinkingTimeoutId);
                        thinkingTimeoutId = setTimeout(() => {
                            thinkingTimeoutId = null;
                            if (storage.getState().realtimeMode === 'thinking') {
                                setRealtimeModeIfCurrent(version, 'idle', true);
                            }
                        }, THINKING_TIMEOUT_MS);
                    } else if (data.state === 'idle' || data.state === 'listening') {
                        // Agent finished processing without speaking — clear thinking
                        if (thinkingTimeoutId) { clearTimeout(thinkingTimeoutId); thinkingTimeoutId = null; }
                        if (storage.getState().realtimeMode === 'thinking') {
                            setRealtimeModeIfCurrent(version, 'idle', true);
                        }
                    } else if (data.state === 'speaking') {
                        // Speaking is handled by ActiveSpeakersChanged, but clear timeout
                        if (thinkingTimeoutId) { clearTimeout(thinkingTimeoutId); thinkingTimeoutId = null; }
                    }
                } catch {}
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
            setRealtimeStatusIfCurrent(version, 'connected');
            setRealtimeModeIfCurrent(version, 'idle', true);
        } catch (error) {
            console.error('[HappyVoice] Failed to start session:', error);
            setRealtimeStatusIfCurrent(version, 'error');
        }
    }

    async endSession(): Promise<void> {
        if (thinkingTimeoutId) { clearTimeout(thinkingTimeoutId); thinkingTimeoutId = null; }
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

    async setMicrophoneMuted(muted: boolean): Promise<void> {
        if (!roomInstance) {
            console.warn('[HappyVoice] No active room for mute toggle');
            return;
        }
        try {
            await roomInstance.localParticipant.setMicrophoneEnabled(!muted);
        } catch (error) {
            console.error('[HappyVoice] Failed to set mic muted state:', error);
        }
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
