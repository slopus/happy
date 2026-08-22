import {
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceConversationResponse,
    type VoiceUsageResponse,
} from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { config } from '@/config';

export type { VoiceConversationResponse, VoiceUsageResponse };

const VOICE_API_TIMEOUT_MS = 35_000;

async function fetchVoiceApi(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VOICE_API_TIMEOUT_MS);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

export async function fetchVoiceCredentials(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    const serverUrl = getServerUrl();

    const agentId = config.elevenLabsAgentId;

    if (!agentId) {
        throw new Error('Agent ID not configured');
    }

    const response = await fetchVoiceApi(`${serverUrl}/v1/voice/conversations`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            agentId
        })
    });

    if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        const detail = typeof body?.error === 'string' ? `: ${body.error}` : '';
        throw new Error(`Voice token request failed (${response.status})${detail}`);
    }

    return VoiceConversationResponseSchema.parse(await response.json());
}

export async function fetchVoiceUsage(
    credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    const serverUrl = getServerUrl();

    const response = await fetchVoiceApi(`${serverUrl}/v1/voice/usage`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
        },
    });

    if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        const detail = typeof body?.error === 'string' ? `: ${body.error}` : '';
        throw new Error(`Voice usage request failed (${response.status})${detail}`);
    }

    return VoiceUsageResponseSchema.parse(await response.json());
}
