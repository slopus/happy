import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { storage } from './storage';

export interface VoiceTokenResponse {
    allowed: boolean;
    token?: string;
    agentId?: string;
}

export async function fetchVoiceToken(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceTokenResponse> {
    const serverUrl = getServerUrl();
    const userId = storage.getState().profile.id;
    console.log(`[Voice] User ID: ${userId}`);

    // Get agent ID from config
    const agentId = __DEV__
        ? config.elevenLabsAgentIdDev
        : config.elevenLabsAgentIdProd;

    if (!agentId) {
        throw new Error('Agent ID not configured');
    }

    const response = await fetch(`${serverUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sessionId,
            agentId
        })
    });

    if (!response.ok) {
        // 400 means the endpoint doesn't exist yet on this server.
        // Allow voice anyway to not break users on experimental/custom servers
        // that haven't been updated with the token endpoint yet.
        if (response.status === 400) {
            return { allowed: true };
        }
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return await response.json();
}