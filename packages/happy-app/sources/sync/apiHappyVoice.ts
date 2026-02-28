import { getHappyVoiceGatewayUrl, getHappyVoicePublicKey } from './voiceConfig';
import { getServerUrl } from './serverConfig';
import { storage } from './storage';
import type { HappyVoiceContextPayload } from '@/realtime/HappyVoiceContextSerializer';

export interface HappyVoiceStartResponse {
    allowed: boolean;
    gatewaySessionId: string;
    roomName: string;
    roomUrl: string;
    participantIdentity: string;
    participantToken: string;
    expiresAt: string;
}

function getVoiceGatewayUrl() {
    const baseUrl = getHappyVoiceGatewayUrl();
    if (!baseUrl) {
        throw new Error('voiceBaseUrl is not configured');
    }
    if (baseUrl.startsWith('/')) {
        const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
        if (typeof origin === 'string' && origin) {
            return `${origin}${baseUrl}`.replace(/\/+$/, '');
        }
    }
    return baseUrl.replace(/\/+$/, '');
}

function getVoiceGatewayHeaders() {
    const voicePublicKey = getHappyVoicePublicKey();
    if (!voicePublicKey) {
        throw new Error('voicePublicKey is not configured');
    }

    return {
        'Content-Type': 'application/json',
        'x-voice-key': voicePublicKey,
    };
}

export async function startHappyVoiceSession(
    sessionId: string,
    initialContextPayload?: HappyVoiceContextPayload,
    language?: string,
    welcomeMessage?: string,
): Promise<HappyVoiceStartResponse> {
    const userId = storage.getState().profile.id;
    if (!userId) {
        throw new Error('profile.id is missing');
    }

    const toolBridgeBaseUrl = process.env.EXPO_PUBLIC_VOICE_TOOL_BRIDGE_BASE_URL || getServerUrl();

    const response = await fetch(`${getVoiceGatewayUrl()}/v1/voice/session/start`, {
        method: 'POST',
        headers: getVoiceGatewayHeaders(),
        body: JSON.stringify({
            userId,
            sessionId,
            initialContextPayload,
            language,
            toolBridgeBaseUrl,
            welcomeMessage,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to start voice session: ${response.status} ${errorText}`);
    }

    return await response.json();
}

export async function stopHappyVoiceSession(gatewaySessionId: string): Promise<void> {
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

export async function sendHappyVoiceText(gatewaySessionId: string, message: string): Promise<void> {
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

export async function sendHappyVoiceContext(
    gatewaySessionId: string,
    payload: HappyVoiceContextPayload,
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
