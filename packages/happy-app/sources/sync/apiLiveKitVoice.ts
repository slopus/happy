import { config } from '@/config';
import { storage } from './storage';
import type { LiveKitContextPayload } from '@/realtime/LiveKitContextSerializer';

export interface LiveKitVoiceStartResponse {
    allowed: boolean;
    gatewaySessionId: string;
    roomName: string;
    roomUrl: string;
    participantIdentity: string;
    participantToken: string;
    expiresAt: string;
}

function getVoiceGatewayUrl() {
    const baseUrl = config.voiceBaseUrl;
    if (!baseUrl) {
        throw new Error('voiceBaseUrl is not configured');
    }
    return baseUrl.replace(/\/+$/, '');
}

function getVoiceGatewayHeaders() {
    const voicePublicKey = config.voicePublicKey;
    if (!voicePublicKey) {
        throw new Error('voicePublicKey is not configured');
    }

    return {
        'Content-Type': 'application/json',
        'x-voice-key': voicePublicKey,
    };
}

export async function startLiveKitVoiceSession(
    sessionId: string,
    initialContextPayload?: LiveKitContextPayload,
    language?: string,
): Promise<LiveKitVoiceStartResponse> {
    const userId = storage.getState().profile.id;
    if (!userId) {
        throw new Error('profile.id is missing');
    }

    const response = await fetch(`${getVoiceGatewayUrl()}/v1/voice/session/start`, {
        method: 'POST',
        headers: getVoiceGatewayHeaders(),
        body: JSON.stringify({
            userId,
            sessionId,
            initialContextPayload,
            language,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to start voice session: ${response.status} ${errorText}`);
    }

    return await response.json();
}

export async function stopLiveKitVoiceSession(gatewaySessionId: string): Promise<void> {
    const response = await fetch(`${getVoiceGatewayUrl()}/v1/voice/session/stop`, {
        method: 'POST',
        headers: getVoiceGatewayHeaders(),
        body: JSON.stringify({ gatewaySessionId }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to stop voice session: ${response.status} ${errorText}`);
    }
}

export async function sendLiveKitVoiceText(gatewaySessionId: string, message: string): Promise<void> {
    const response = await fetch(`${getVoiceGatewayUrl()}/v1/voice/session/text`, {
        method: 'POST',
        headers: getVoiceGatewayHeaders(),
        body: JSON.stringify({ gatewaySessionId, message }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to send voice text: ${response.status} ${errorText}`);
    }
}

export async function sendLiveKitVoiceContext(
    gatewaySessionId: string,
    payload: LiveKitContextPayload,
): Promise<void> {
    const response = await fetch(`${getVoiceGatewayUrl()}/v1/voice/session/context`, {
        method: 'POST',
        headers: getVoiceGatewayHeaders(),
        body: JSON.stringify({ gatewaySessionId, payload }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to send voice context: ${response.status} ${errorText}`);
    }
}
