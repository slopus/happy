import {
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceConversationResponse,
    type VoiceUsageResponse,
} from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl, getVoiceServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { config } from '@/config';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/encryption/base64';

export type { VoiceConversationResponse, VoiceUsageResponse };

async function getVoiceEndpoint(credentials: AuthCredentials): Promise<{ serverUrl: string; token: string }> {
    const serverUrl = getVoiceServerUrl();
    if (serverUrl === getServerUrl()) {
        return { serverUrl, token: credentials.token };
    }

    const secret = decodeBase64(credentials.secret, 'base64url');
    const token = await authGetToken(secret, serverUrl);
    return { serverUrl, token };
}

export async function fetchVoiceCredentials(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    const { serverUrl, token } = await getVoiceEndpoint(credentials);

    const agentId = config.elevenLabsAgentId;

    if (!agentId) {
        throw new Error('Agent ID not configured');
    }

    const response = await fetch(`${serverUrl}/v1/voice/conversations`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            agentId
        })
    });

    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return VoiceConversationResponseSchema.parse(await response.json());
}

export async function fetchVoiceUsage(
    credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    const { serverUrl, token } = await getVoiceEndpoint(credentials);

    const response = await fetch(`${serverUrl}/v1/voice/usage`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Happy-Client': getHappyClientId(),
        },
    });

    if (!response.ok) {
        throw new Error(`Voice usage request failed: ${response.status}`);
    }

    return VoiceUsageResponseSchema.parse(await response.json());
}
