import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';

export type VoiceTokenResponse =
    | { allowed: true; token: string; agentId: string; elevenUserId: string; usedSeconds: number; limitSeconds: number }
    | { allowed: false; reason: 'voice_limit_reached'; usedSeconds: number; limitSeconds: number; agentId: string };

export async function fetchVoiceToken(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceTokenResponse> {
    const serverUrl = getServerUrl();

    const agentId = config.elevenLabsAgentId;

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
            agentId
        })
    });

    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return await response.json();
}