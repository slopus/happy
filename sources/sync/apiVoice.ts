/**
 * API functions for voice assistant integration.
 *
 * Fetches conversation tokens from the server for ElevenLabs integration.
 * The server handles authentication with ElevenLabs API, keeping credentials secure.
 */

import { getServerUrl } from '@/sync/serverConfig';
import { getCurrentAuth } from '@/auth/AuthContext';

export interface VoiceTokenResponse {
    allowed: boolean;
    token?: string;
    agentId?: string;
    error?: string;
}

/**
 * Fetch a conversation token from the server for ElevenLabs voice sessions.
 *
 * This uses the private agent flow where:
 * 1. Server holds the ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID
 * 2. Server fetches a short-lived conversation token from ElevenLabs
 * 3. Client uses this token to establish WebRTC connection
 *
 * @returns Object with allowed status, and if allowed, the token and agentId
 * @throws Error if not authenticated or network failure
 */
export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
    const auth = getCurrentAuth();
    if (!auth?.credentials?.token) {
        throw new Error('Not authenticated');
    }

    const serverUrl = getServerUrl();
    const response = await fetch(`${serverUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${auth.credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        return {
            allowed: false,
            error: errorData.error || `Server error: ${response.status}`
        };
    }

    const data = await response.json();
    return data as VoiceTokenResponse;
}
